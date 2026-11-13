import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { api, patch } from "../src/client/lib/api";
import { useMailStore } from "../src/client/stores/mail";
import { replyRecipients } from "../src/client/lib/compose";
import type {
  MailMessage,
  MessageDetail,
  MessagePage,
} from "../src/shared/types";

vi.mock("../src/client/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/client/lib/api")>()),
  api: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
}));
const row = (id: string): MailMessage => ({
  id,
  direction: "inbound",
  from_address: "sender@example.net",
  from_name: null,
  to_addresses: ["inbox@example.com"],
  cc_addresses: [],
  subject: id,
  snippet: "",
  status: "received",
  is_read: 1,
  is_starred: 0,
  is_archived: 0,
  is_deleted: 0,
  has_attachments: 0,
  received_at: 1,
  mailbox_email: "inbox@example.com",
  domain_name: "example.com",
});
const detail = (id: string): MessageDetail => ({
  ...row(id),
  message_id: null,
  references_header: null,
  bcc_addresses: [],
  reply_to_addresses: [],
  body_text: "",
  body_html: null,
  attachments: [],
  send_error: null,
});
const page = (id: string): MessagePage => ({
  items: [row(id)],
  total: 1,
  offset: 0,
  limit: 50,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  setActivePinia(createPinia());
  vi.resetAllMocks();
});

describe("reply recipients", () => {
  it("uses all explicit Reply-To addresses instead of the From address", () => {
    const message = {
      ...detail("reply"),
      from_address: "noreply@example.net",
      reply_to_addresses: ["support@example.net", "owner@example.net"],
    };
    expect(replyRecipients(message)).toEqual([
      "support@example.net",
      "owner@example.net",
    ]);
  });
  it("falls back to From when an incoming email has no Reply-To", () => {
    expect(replyRecipients(detail("reply"))).toEqual(["sender@example.net"]);
  });
  it("keeps the original recipients when replying to sent mail", () => {
    expect(
      replyRecipients({
        ...detail("sent"),
        direction: "outbound",
        to_addresses: ["recipient@example.net", "second@example.net"],
        reply_to_addresses: ["my-support@example.com"],
      }),
    ).toEqual(["recipient@example.net", "second@example.net"]);
  });
});

describe("mail loading", () => {
  it("resets an empty paginated folder to its first page", async () => {
    vi.mocked(api).mockResolvedValue({
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
    });
    const store = useMailStore();
    store.offset = 50;
    await store.load();
    expect(store.offset).toBe(0);
    expect(api).toHaveBeenCalledTimes(2);
  });
  it("does not restore private stats after logout", async () => {
    const response = deferred<unknown>();
    vi.mocked(api).mockReturnValueOnce(response.promise);
    const store = useMailStore(),
      loading = store.loadStats();
    store.reset();
    response.resolve({
      stats: { domains: 5, mailboxes: 5, messages: 100, unread: 10 },
      resendConfigured: true,
      webhookConfigured: true,
      failures: [],
    });
    await loading;
    expect(store.stats.messages).toBe(0);
  });
  it("ignores a stale list response after filters change", async () => {
    const old = deferred<MessagePage>(),
      latest = deferred<MessagePage>();
    vi.mocked(api)
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(latest.promise);
    const store = useMailStore(),
      first = store.load();
    store.query = "latest";
    const second = store.load(true);
    latest.resolve(page("latest"));
    await second;
    old.resolve(page("old"));
    await first;
    expect(store.messages.map((m) => m.id)).toEqual(["latest"]);
    expect(store.loading).toBe(false);
  });
  it("ignores a stale detail response after another message opens", async () => {
    const old = deferred<MessageDetail>(),
      latest = deferred<MessageDetail>();
    vi.mocked(api)
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(latest.promise);
    const store = useMailStore(),
      first = store.open("old"),
      second = store.open("latest");
    latest.resolve(detail("latest"));
    await second;
    old.resolve(detail("old"));
    await first;
    expect(store.selected?.id).toBe("latest");
  });
  it("invalidates in-flight loads on logout and exposes network errors", async () => {
    const old = deferred<MessagePage>();
    vi.mocked(api).mockReturnValueOnce(old.promise);
    const store = useMailStore(),
      loading = store.load();
    store.reset();
    old.resolve(page("private"));
    await loading;
    expect(store.messages).toEqual([]);
    vi.mocked(api).mockRejectedValueOnce(new Error("Network unavailable"));
    await store.load();
    expect(store.error).toBe("Network unavailable");
    expect(store.loading).toBe(false);
  });
  it("returns to a valid page when the last item on a page is removed", async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({ items: [], total: 50, limit: 50, offset: 50 })
      .mockResolvedValueOnce({ ...page("remaining"), total: 50 });
    const store = useMailStore();
    store.offset = 50;
    await store.load();
    expect(store.offset).toBe(0);
    expect(store.messages[0].id).toBe("remaining");
    expect(api).toHaveBeenCalledTimes(2);
  });
  it("surfaces failed mutations instead of silently removing mail", async () => {
    vi.mocked(patch).mockRejectedValueOnce(new Error("Database unavailable"));
    const store = useMailStore();
    store.messages = [row("keep")];
    await store.trash(store.messages[0]);
    expect(store.messages).toHaveLength(1);
    expect(store.error).toBe("Database unavailable");
  });
});
