import { afterEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  createDraftPersistence,
  DraftConflictError,
  DraftNotSavedError,
  emptyDraft,
  indexedDraftStorage,
  sendPersistedDraft,
  type DraftSnapshot,
  type DraftStorage,
} from "../src/client/lib/drafts";

const connections: ReturnType<typeof indexedDraftStorage>[] = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map((storage) => storage.close()));
});
function storage(factory = new IDBFactory()) {
  const connection = indexedDraftStorage(factory, "folio-draft-test");
  connections.push(connection);
  return connection;
}
function snapshot(): DraftSnapshot {
  return {
    version: 1,
    draft: {
      ...emptyDraft(),
      mailboxId: "personal",
      to: "recipient@example.net",
      cc: "colleague@example.net",
      bcc: "private@example.net",
      subject: "Draft subject",
      text: "Original unsent content",
      inReplyTo: "<previous@example.net>",
      references: "<root@example.net> <previous@example.net>",
      attachments: [
        {
          filename: "notes.txt",
          content: "dGVzdA==",
          contentType: "text/plain",
        },
      ],
    },
    mode: "replyAll",
    showCc: true,
    showBcc: true,
    locked: false,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe("local draft IndexedDB storage", () => {
  it("restores all current-draft fields and attachments after closing and reopening the database", async () => {
    const factory = new IDBFactory();
    const original = snapshot();
    const firstStorage = storage(factory);
    const first = createDraftPersistence(firstStorage);
    expect(await first.restore()).toBeNull();
    await first.save(original);
    await firstStorage.close();
    const reopened = createDraftPersistence(storage(factory));
    expect(await reopened.restore()).toEqual(original);
    expect(reopened.ready.value).toBe(true);
    expect(reopened.state.value).toBe("saved");
  });

  it("commits the locked draft and stable key before submitting and uses the exact saved snapshot", async () => {
    const database = storage();
    const gate = deferred<void>();
    const writing = deferred<void>();
    const delayed: DraftStorage = {
      read: database.read,
      write: async (revision, value) => {
        writing.resolve();
        await gate.promise;
        return database.write(revision, value);
      },
    };
    const drafts = createDraftPersistence(delayed);
    await drafts.restore();
    const original = snapshot();
    const key = original.draft.idempotencyKey;
    const submit = vi.fn(async (draft) => {
      const record = await database.read();
      expect(record.snapshot?.locked).toBe(true);
      expect(record.snapshot?.draft).toEqual(draft);
      return { id: "submitted-message" };
    });
    const sending = sendPersistedDraft(original, drafts.save, submit);
    await writing.promise;
    expect(submit).not.toHaveBeenCalled();
    original.draft.text = "A late edit cannot change the submitted payload";
    gate.resolve();
    await expect(sending).resolves.toEqual({ id: "submitted-message" });
    expect(submit.mock.calls[0][0].text).toBe("Original unsent content");
    expect(submit.mock.calls[0][0].idempotencyKey).toBe(key);
  });

  it("retains the original key and lock across reload when submission outcome is unknown", async () => {
    const factory = new IDBFactory();
    const database = storage(factory);
    const drafts = createDraftPersistence(database);
    await drafts.restore();
    const original = snapshot();
    await expect(
      sendPersistedDraft(original, drafts.save, async () => {
        throw new Error("Network response lost");
      }),
    ).rejects.toThrow("Network response lost");
    const restored = await createDraftPersistence(storage(factory)).restore();
    expect(restored?.locked).toBe(true);
    expect(restored?.draft.id).toBe(original.draft.id);
    expect(restored?.draft.idempotencyKey).toBe(original.draft.idempotencyKey);
    expect(restored?.draft.attachments).toEqual(original.draft.attachments);
  });

  it("does not submit when saving fails and exposes an error that can be retried", async () => {
    const database = storage();
    let full = true;
    const drafts = createDraftPersistence({
      read: database.read,
      write: (revision, value) =>
        full
          ? Promise.reject(
              new DOMException("Storage quota exceeded", "QuotaExceededError"),
            )
          : database.write(revision, value),
    });
    await drafts.restore();
    const submit = vi.fn(async () => ({ id: "sent" }));
    const original = snapshot();
    await expect(
      sendPersistedDraft(original, drafts.save, submit),
    ).rejects.toBeInstanceOf(DraftNotSavedError);
    expect(submit).not.toHaveBeenCalled();
    expect(drafts.state.value).toBe("error");
    expect((await database.read()).snapshot).toBeNull();
    full = false;
    await sendPersistedDraft(original, drafts.save, submit);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(drafts.state.value).toBe("saved");
  });

  it("clears a sent/discarded draft after an in-flight save and cannot revive it with queued or late saves", async () => {
    const database = storage();
    const gate = deferred<void>(),
      started = deferred<void>();
    let delay = true;
    const drafts = createDraftPersistence({
      read: database.read,
      write: async (revision, value) => {
        if (delay) {
          delay = false;
          started.resolve();
          await gate.promise;
        }
        return database.write(revision, value);
      },
    });
    await drafts.restore();
    const old = snapshot();
    const firstSave = drafts.save(old);
    await started.promise;
    const queuedSave = drafts.save({
      ...old,
      draft: { ...old.draft, text: "Queued edit" },
    });
    const removing = drafts.remove();
    gate.resolve();
    await expect(firstSave).resolves.toBe(false);
    await expect(queuedSave).resolves.toBe(false);
    await removing;
    expect((await database.read()).snapshot).toBeNull();
    await expect(drafts.save(old)).resolves.toBe(false);
    expect((await database.read()).snapshot).toBeNull();
    const fresh = snapshot();
    await expect(drafts.save(fresh)).resolves.toBe(true);
    expect((await database.read()).snapshot?.draft.id).toBe(fresh.draft.id);
  });

  it("rejects stale saves and deletes from another tab instead of overwriting an active draft", async () => {
    const factory = new IDBFactory();
    const database = storage(factory);
    const first = createDraftPersistence(database);
    const second = createDraftPersistence(storage(factory));
    await Promise.all([first.restore(), second.restore()]);
    const firstDraft = snapshot();
    await first.save(firstDraft);
    await expect(second.save(snapshot())).rejects.toBeInstanceOf(
      DraftConflictError,
    );
    expect(second.state.value).toBe("conflict");
    await expect(second.remove()).rejects.toBeInstanceOf(DraftConflictError);
    expect((await database.read()).snapshot).toEqual(firstDraft);
    await first.remove();
    await expect(second.save(firstDraft)).rejects.toBeInstanceOf(
      DraftConflictError,
    );
    expect((await database.read()).snapshot).toBeNull();
    expect(await createDraftPersistence(storage(factory)).restore()).toBeNull();
  });

  it("allows only one concurrent writer at the same revision in actual IndexedDB transactions", async () => {
    const factory = new IDBFactory();
    const database = storage(factory);
    const one = createDraftPersistence(database);
    const two = createDraftPersistence(storage(factory));
    await Promise.all([one.restore(), two.restore()]);
    const first = snapshot(),
      second = snapshot();
    const results = await Promise.allSettled([
      one.save(first),
      two.save(second),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const record = await database.read();
    expect(record.revision).toBe(1);
    expect([first.draft.id, second.draft.id]).toContain(
      record.snapshot?.draft.id,
    );
  });

  it("keeps a draft when deletion fails, then permits a successful retry", async () => {
    const database = storage();
    let failDeletion = true;
    const drafts = createDraftPersistence({
      read: database.read,
      write: (revision, value) =>
        value === null && failDeletion
          ? Promise.reject(new DOMException("Storage error", "UnknownError"))
          : database.write(revision, value),
    });
    const original = snapshot();
    await drafts.restore();
    await drafts.save(original);
    await expect(drafts.remove()).rejects.toThrow("Storage error");
    expect(drafts.state.value).toBe("error");
    expect((await database.read()).snapshot).toEqual(original);
    await expect(drafts.save(original)).resolves.toBe(true);
    failDeletion = false;
    await drafts.remove();
    expect((await database.read()).snapshot).toBeNull();
  });

  it("does not claim storage is ready or submit when the saved draft cannot be read", async () => {
    const blocked = {
      open: () => {
        throw new DOMException("Blocked", "SecurityError");
      },
    } as unknown as globalThis.IDBFactory;
    const drafts = createDraftPersistence(indexedDraftStorage(blocked));
    await expect(drafts.restore()).rejects.toThrow("Blocked");
    expect(drafts.ready.value).toBe(false);
    expect(drafts.state.value).toBe("error");
    const submit = vi.fn();
    await expect(
      sendPersistedDraft(snapshot(), drafts.save, submit),
    ).rejects.toBeInstanceOf(DraftNotSavedError);
    expect(submit).not.toHaveBeenCalled();
  });
});
