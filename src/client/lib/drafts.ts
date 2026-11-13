import { ref } from "vue";
import type { ComposeAttachment } from "../../shared/types";
import type { ComposeMode } from "./compose";

export interface ComposeDraft {
  id: string;
  mailboxId: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  inReplyTo: string;
  references: string;
  attachments: ComposeAttachment[];
  idempotencyKey: string;
}

export const emptyDraft = (): ComposeDraft => ({
  id: crypto.randomUUID(),
  mailboxId: "",
  to: "",
  cc: "",
  bcc: "",
  subject: "",
  text: "",
  inReplyTo: "",
  references: "",
  attachments: [],
  idempotencyKey: crypto.randomUUID(),
});

export interface DraftSnapshot {
  version: 1;
  draft: ComposeDraft;
  mode: ComposeMode;
  showCc: boolean;
  showBcc: boolean;
  locked: boolean;
}

export interface DraftRecord {
  revision: number;
  snapshot: DraftSnapshot | null;
}

export interface DraftStorage {
  read(): Promise<DraftRecord>;
  write(
    expectedRevision: number,
    snapshot: DraftSnapshot | null,
  ): Promise<DraftRecord>;
}

export class DraftConflictError extends Error {
  constructor() {
    super("The saved draft changed in another tab");
  }
}

export class DraftNotSavedError extends Error {
  constructor() {
    super("Save the draft and retry key before sending");
  }
}

export async function sendPersistedDraft<T>(
  snapshot: DraftSnapshot,
  save: (snapshot: DraftSnapshot) => Promise<boolean>,
  submit: (draft: ComposeDraft) => Promise<T>,
): Promise<T> {
  const locked = structuredClone({ ...snapshot, locked: true });
  try {
    if (!(await save(locked))) throw new DraftNotSavedError();
  } catch {
    throw new DraftNotSavedError();
  }
  return submit(locked.draft);
}

function validSnapshot(value: unknown): value is DraftSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as DraftSnapshot;
  const draft = snapshot.draft;
  if (
    snapshot.version !== 1 ||
    !["new", "reply", "replyAll", "forward"].includes(snapshot.mode) ||
    typeof snapshot.locked !== "boolean" ||
    typeof snapshot.showCc !== "boolean" ||
    typeof snapshot.showBcc !== "boolean" ||
    !draft ||
    typeof draft !== "object"
  )
    return false;
  const fields = [
    "id",
    "mailboxId",
    "to",
    "cc",
    "bcc",
    "subject",
    "text",
    "inReplyTo",
    "references",
    "idempotencyKey",
  ] as const;
  return (
    fields.every((field) => typeof draft[field] === "string") &&
    !!draft.id &&
    !!draft.idempotencyKey &&
    draft.idempotencyKey.length <= 200 &&
    Array.isArray(draft.attachments) &&
    draft.attachments.length <= 10 &&
    draft.attachments.every(
      (attachment) =>
        attachment &&
        typeof attachment.filename === "string" &&
        typeof attachment.content === "string" &&
        typeof attachment.contentType === "string",
    )
  );
}

function readRecord(value: unknown): DraftRecord {
  if (value === undefined) return { revision: 0, snapshot: null };
  const record = value as DraftRecord;
  if (
    !record ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 0 ||
    (record.snapshot !== null && !validSnapshot(record.snapshot))
  )
    throw new Error("The saved draft has an unsupported format");
  return record;
}

/** A single local draft with atomic revision checks, including after deletion. */
export function indexedDraftStorage(
  factory?: IDBFactory,
  databaseName = "folio-drafts-v1",
): DraftStorage & { close(): Promise<void> } {
  let opening: Promise<IDBDatabase> | undefined;
  function open() {
    if (opening) return opening;
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      const indexed = factory || globalThis.indexedDB;
      if (!indexed) {
        reject(new Error("IndexedDB is unavailable"));
        return;
      }
      const request = indexed.open(databaseName, 1);
      let blocked = false;
      request.onupgradeneeded = () =>
        request.result.createObjectStore("drafts");
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        blocked = true;
        reject(new Error("Draft storage is blocked by another tab"));
      };
      request.onsuccess = () => {
        if (blocked) {
          request.result.close();
          return;
        }
        request.result.onversionchange = () => {
          request.result.close();
          opening = undefined;
        };
        resolve(request.result);
      };
    }).catch((error) => {
      opening = undefined;
      throw error;
    });
    return opening;
  }
  async function transaction(
    expectedRevision?: number,
    snapshot?: DraftSnapshot | null,
  ) {
    const database = await open();
    return new Promise<DraftRecord>((resolve, reject) => {
      const writing = expectedRevision !== undefined;
      const tx = database.transaction(
        "drafts",
        writing ? "readwrite" : "readonly",
      );
      const store = tx.objectStore("drafts");
      let result: DraftRecord;
      let failure: unknown;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () =>
        reject(
          failure || tx.error || new Error("Draft storage transaction failed"),
        );
      tx.onerror = () => {
        failure ||= tx.error;
      };
      const request = store.get("current");
      request.onsuccess = () => {
        try {
          result = readRecord(request.result);
          if (!writing) return;
          if (result.revision !== expectedRevision)
            throw new DraftConflictError();
          if (snapshot !== null && !validSnapshot(snapshot))
            throw new Error("Invalid draft snapshot");
          result = {
            revision: result.revision + 1,
            snapshot: snapshot || null,
          };
          // Keep a tombstone: stale tabs cannot recreate a draft after it was discarded/sent.
          store.put(result, "current");
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
    });
  }
  return {
    read: () => transaction(),
    write: (revision, snapshot) => transaction(revision, snapshot),
    async close() {
      if (opening) (await opening).close();
      opening = undefined;
    },
  };
}

/** Serializes writes and invalidates queued saves before restore or deletion. */
export function createDraftPersistence(
  storage: DraftStorage = indexedDraftStorage(),
) {
  const ready = ref(false);
  const state = ref<"idle" | "saving" | "saved" | "error" | "conflict">("idle");
  let revision = 0;
  let generation = 0;
  let activeDraftId: string | null = null;
  const retiredDrafts = new Set<string>();
  let tail: Promise<unknown> = Promise.resolve();
  function enqueue<T>(action: () => Promise<T>) {
    const result = tail.then(action);
    tail = result.catch(() => {});
    return result;
  }
  function failure(error: unknown, epoch: number): never {
    if (epoch === generation)
      state.value = error instanceof DraftConflictError ? "conflict" : "error";
    throw error;
  }
  async function restore(): Promise<DraftSnapshot | null> {
    const epoch = ++generation;
    ready.value = false;
    try {
      return await enqueue(async () => {
        const record = await storage.read();
        revision = record.revision;
        activeDraftId = record.snapshot?.draft.id || null;
        ready.value = true;
        state.value = record.snapshot ? "saved" : "idle";
        return record.snapshot;
      });
    } catch (error) {
      return failure(error, epoch);
    }
  }
  async function save(snapshot: DraftSnapshot): Promise<boolean> {
    const epoch = generation;
    const copy = structuredClone(snapshot);
    if (retiredDrafts.has(copy.draft.id)) return false;
    activeDraftId = copy.draft.id;
    state.value = "saving";
    try {
      return await enqueue(async () => {
        if (epoch !== generation) return false;
        if (!ready.value)
          throw new Error("Restore the saved draft before writing");
        const record = await storage.write(revision, copy);
        revision = record.revision;
        if (epoch !== generation) return false;
        state.value = "saved";
        return true;
      });
    } catch (error) {
      return failure(error, epoch);
    }
  }
  async function remove(): Promise<void> {
    const epoch = ++generation;
    const removedId = activeDraftId;
    if (removedId) retiredDrafts.add(removedId);
    state.value = "saving";
    try {
      await enqueue(async () => {
        if (!ready.value)
          throw new Error("Restore the saved draft before deleting");
        const record = await storage.write(revision, null);
        revision = record.revision;
        activeDraftId = null;
        state.value = "idle";
      });
    } catch (error) {
      if (removedId) retiredDrafts.delete(removedId);
      failure(error, epoch);
    }
  }
  return { ready, state, restore, save, remove };
}
