import { computed, ref } from "vue";
import type { ComposeAttachment } from "../../shared/types";

export class AttachmentError extends Error {
  constructor(
    public readonly code: "limit" | "read",
    public readonly filename = "",
  ) {
    super(code);
  }
}

export function readAttachment(
  file: File,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => reader.abort();
    const finish = (action: () => void) => {
      signal.removeEventListener("abort", abort);
      action();
    };
    if (signal.aborted) {
      reject(new DOMException("Attachment reading cancelled", "AbortError"));
      return;
    }
    reader.onload = () =>
      finish(() => resolve(String(reader.result).split(",")[1] || ""));
    reader.onerror = () => finish(() => reject(reader.error));
    reader.onabort = () =>
      finish(() =>
        reject(new DOMException("Attachment reading cancelled", "AbortError")),
      );
    signal.addEventListener("abort", abort, { once: true });
    try {
      reader.readAsDataURL(file);
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

const attachmentSize = (content: string) =>
  Math.floor((content.length * 3) / 4) -
  (content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0);

/** Queue reads within one draft; cancelled or replaced drafts never receive late files. */
export function createAttachmentQueue(
  getDraft: () => { attachments: ComposeAttachment[] },
  readFile = readAttachment,
) {
  const pending = ref(0);
  let generation = 0;
  let tail = Promise.resolve();
  let activeRead: AbortController | null = null;

  function cancel() {
    generation++;
    pending.value = 0;
    activeRead?.abort();
    activeRead = null;
    tail = Promise.resolve();
  }

  function add(files: File[]): Promise<void> {
    const draft = getDraft();
    const epoch = generation;
    let remaining = files.length;
    pending.value += remaining;
    const current = () => epoch === generation && draft === getDraft();
    const task = tail.then(async () => {
      try {
        for (const file of files) {
          if (!current()) return;
          const bytes = draft.attachments.reduce(
            (total, attachment) => total + attachmentSize(attachment.content),
            0,
          );
          if (
            draft.attachments.length >= 10 ||
            bytes + file.size > 10 * 1024 * 1024
          )
            throw new AttachmentError("limit");
          const controller = new AbortController();
          activeRead = controller;
          let content: string;
          try {
            content = await readFile(file, controller.signal);
          } catch {
            if (!current()) return;
            throw new AttachmentError("read", file.name);
          } finally {
            if (activeRead === controller) activeRead = null;
          }
          if (!current()) return;
          draft.attachments.push({
            filename: file.name,
            content,
            contentType: file.type || "application/octet-stream",
          });
          remaining--;
          pending.value--;
        }
      } finally {
        if (epoch === generation) pending.value -= remaining;
      }
    });
    tail = task.catch(() => {});
    return task;
  }

  return { add, cancel, pending, loading: computed(() => pending.value > 0) };
}
