import { describe, expect, it, vi } from "vitest";
import {
  AttachmentError,
  createAttachmentQueue,
} from "../src/client/lib/attachments";
import type { ComposeAttachment } from "../src/shared/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

const file = (name = "notes.txt") =>
  new File(["test"], name, { type: "text/plain" });

describe("composer attachment reads", () => {
  it("keeps sending blocked until every selected attachment has finished", async () => {
    const first = deferred<string>(),
      second = deferred<string>();
    const read = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const draft = { attachments: [] as ComposeAttachment[] };
    const queue = createAttachmentQueue(() => draft, read);
    const adding = queue.add([file("one.txt"), file("two.txt")]);
    expect(queue.loading.value).toBe(true);
    await Promise.resolve();
    first.resolve("dGVzdA==");
    await Promise.resolve();
    expect(queue.loading.value).toBe(true);
    expect(draft.attachments.map((a) => a.filename)).toEqual(["one.txt"]);
    second.resolve("dGVzdA==");
    await adding;
    expect(queue.loading.value).toBe(false);
    expect(draft.attachments).toHaveLength(2);
  });

  it("aborts closed-draft reads and ignores late results even from readers that ignore abort", async () => {
    const oldRead = deferred<string>();
    let signal: AbortSignal | undefined;
    let draft = { attachments: [] as ComposeAttachment[] };
    const queue = createAttachmentQueue(
      () => draft,
      async (_file, incoming) => {
        signal = incoming;
        return oldRead.promise;
      },
    );
    const adding = queue.add([file("private-old-draft.txt")]);
    await Promise.resolve();
    queue.cancel();
    expect(signal?.aborted).toBe(true);
    draft = { attachments: [] };
    oldRead.resolve("dGVzdA==");
    await adding;
    expect(draft.attachments).toEqual([]);
    expect(queue.pending.value).toBe(0);
  });

  it("detects a replaced draft even if its caller forgot to cancel", async () => {
    const reading = deferred<string>();
    let draft = { attachments: [] as ComposeAttachment[] };
    const queue = createAttachmentQueue(
      () => draft,
      () => reading.promise,
    );
    const adding = queue.add([file()]);
    await Promise.resolve();
    draft = { attachments: [] };
    reading.resolve("dGVzdA==");
    await adding;
    expect(draft.attachments).toEqual([]);
    expect(queue.loading.value).toBe(false);
  });

  it("serializes overlapping selections so limits cannot be exceeded by concurrent reads", async () => {
    const draft = {
      attachments: Array.from({ length: 9 }, () => ({
        filename: "old.txt",
        content: "dGVzdA==",
        contentType: "text/plain",
      })),
    };
    const read = vi.fn(async () => "dGVzdA==");
    const queue = createAttachmentQueue(() => draft, read);
    const first = queue.add([file("last.txt")]);
    const second = queue.add([file("excess.txt")]);
    await first;
    await expect(second).rejects.toMatchObject({ code: "limit" });
    expect(read).toHaveBeenCalledTimes(1);
    expect(draft.attachments).toHaveLength(10);
    expect(queue.loading.value).toBe(false);
  });

  it("clears pending state after a file read fails and accepts a later selection", async () => {
    const draft = { attachments: [] as ComposeAttachment[] };
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("Device error"))
      .mockResolvedValueOnce("dGVzdA==");
    const queue = createAttachmentQueue(() => draft, read);
    await expect(queue.add([file()])).rejects.toBeInstanceOf(AttachmentError);
    expect(queue.loading.value).toBe(false);
    await queue.add([file("retry.txt")]);
    expect(draft.attachments[0].filename).toBe("retry.txt");
  });
});
