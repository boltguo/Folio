import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { api, patch, post } from "../src/client/lib/api";
import { useMailStore } from "../src/client/stores/mail";
import type { MessageDetail, MessagePage, Settings } from "../src/shared/types";

vi.mock("../src/client/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/client/lib/api")>()),
  api: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const message = (
  id = "mail",
  values: Partial<MessageDetail> = {},
): MessageDetail => ({
  id,
  direction: "inbound",
  from_address: "sender@example.net",
  from_name: null,
  to_addresses: ["inbox@example.com"],
  cc_addresses: [],
  bcc_addresses: [],
  reply_to_addresses: [],
  subject: id,
  snippet: "Saved body",
  status: "received",
  send_error: null,
  delivery_revision: 0,
  is_read: 1,
  is_starred: 0,
  is_archived: 0,
  is_deleted: 0,
  has_attachments: 0,
  received_at: 1,
  mailbox_email: "inbox@example.com",
  domain_name: "example.com",
  message_id: null,
  references_header: null,
  body_text: "Saved body",
  body_html: null,
  attachments: [],
  deliveries: [],
  ...values,
});
const settings: Settings = {
  stats: { domains: 1, mailboxes: 1, messages: 1, unread: 0 },
  failures: [],
  resendConfigured: true,
  webhookConfigured: true,
};
function page(detail: MessageDetail): MessagePage {
  const { body_text, body_html, attachments, deliveries, ...summary } = detail;
  return { items: [summary], total: 1, offset: 0, limit: 50 };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.resetAllMocks();
});

describe("independent body loading", () => {
  it("shows the body before the read receipt and stats finish", async () => {
    const receipt = deferred<unknown>();
    vi.mocked(api)
      .mockResolvedValueOnce(message("mail", { is_read: 0 }))
      .mockResolvedValueOnce(settings);
    vi.mocked(patch).mockReturnValueOnce(receipt.promise);
    const store = useMailStore();
    const opening = store.open("mail");
    await vi.waitFor(() =>
      expect(store.selected?.body_text).toBe("Saved body"),
    );
    expect(store.opening).toBe(false);
    expect(store.selected?.is_read).toBe(0);
    receipt.resolve({});
    await opening;
    expect(store.selected?.is_read).toBe(1);
  });

  it("keeps the readable body when marking it read fails", async () => {
    vi.mocked(api).mockResolvedValueOnce(message("mail", { is_read: 0 }));
    vi.mocked(patch).mockRejectedValueOnce(
      new Error("Read receipt unavailable"),
    );
    const store = useMailStore();
    await store.open("mail");
    expect(store.selected?.body_text).toBe("Saved body");
    expect(store.selected?.is_read).toBe(0);
    expect(store.error).toBe("Read receipt unavailable");
    expect(store.opening).toBe(false);
  });

  it("keeps the body and read flag when only the stats request fails", async () => {
    vi.mocked(api)
      .mockResolvedValueOnce(message("mail", { is_read: 0 }))
      .mockRejectedValueOnce(new Error("Stats unavailable"));
    vi.mocked(patch).mockResolvedValueOnce({});
    const store = useMailStore();
    await store.open("mail");
    expect(store.selected?.body_text).toBe("Saved body");
    expect(store.selected?.is_read).toBe(1);
    expect(store.error).toBe("Stats unavailable");
  });

  it("does not load private stats after a late read receipt following logout", async () => {
    const receipt = deferred<unknown>();
    vi.mocked(api).mockResolvedValueOnce(message("mail", { is_read: 0 }));
    vi.mocked(patch).mockReturnValueOnce(receipt.promise);
    const store = useMailStore();
    const opening = store.open("mail");
    await vi.waitFor(() => expect(store.selected?.id).toBe("mail"));
    store.reset();
    receipt.resolve({});
    await opening;
    expect(store.selected).toBeNull();
    expect(store.messages).toEqual([]);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("does not show a previously opened body when another detail fails", async () => {
    const store = useMailStore();
    store.selected = message("previous");
    vi.mocked(api).mockRejectedValueOnce(new Error("Detail unavailable"));
    await store.open("missing");
    expect(store.selected).toBeNull();
    expect(store.error).toBe("Detail unavailable");
  });
});

describe("selected delivery refresh", () => {
  const sent = (values: Partial<MessageDetail> = {}) =>
    message("sent", {
      direction: "outbound",
      status: "sent",
      ...values,
    });

  it("updates the visible status immediately and refreshes recipient details", async () => {
    const latest = sent({
      status: "bounced",
      delivery_revision: 1,
      send_error: "Mailbox unavailable",
    });
    latest.deliveries = [
      {
        address: "recipient@example.net",
        recipient_type: "to",
        status: "bounced",
        status_updated_at: 2,
        error_code: null,
        error_message: "Mailbox unavailable",
        complained_at: null,
      },
    ];
    const detail = deferred<MessageDetail>();
    vi.mocked(api)
      .mockResolvedValueOnce(page(latest))
      .mockReturnValueOnce(detail.promise);
    const store = useMailStore();
    store.selected = sent();
    const loading = store.load();
    await vi.waitFor(() => expect(store.selected?.status).toBe("bounced"));
    expect(store.selected?.body_text).toBe("Saved body");
    expect(store.selected?.send_error).toBe("Mailbox unavailable");
    detail.resolve(latest);
    await loading;
    expect(store.selected?.deliveries?.[0].status).toBe("bounced");
    expect(store.detailStale).toBe(false);
  });

  it("retries a failed detail refresh even when the next list metadata is unchanged", async () => {
    const latest = sent({ delivery_revision: 1 });
    vi.mocked(api)
      .mockResolvedValueOnce(page(latest))
      .mockRejectedValueOnce(new Error("Detail unavailable"))
      .mockResolvedValueOnce(page(latest))
      .mockResolvedValueOnce(latest);
    const store = useMailStore();
    store.selected = sent();
    await store.load();
    expect(store.selected?.body_text).toBe("Saved body");
    expect(store.error).toBe("Detail unavailable");
    expect(store.detailStale).toBe(true);
    await store.load();
    expect(store.detailStale).toBe(false);
    expect(api).toHaveBeenCalledTimes(4);
  });

  it.each(["logout", "switch"])(
    "ignores a late background detail after %s",
    async (action) => {
      const latest = sent({ delivery_revision: 1 });
      const detail = deferred<MessageDetail>();
      vi.mocked(api)
        .mockResolvedValueOnce(page(latest))
        .mockReturnValueOnce(detail.promise);
      const store = useMailStore();
      store.selected = sent();
      const loading = store.load();
      await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(2));
      if (action === "logout") store.reset();
      else {
        vi.mocked(api).mockResolvedValueOnce(message("next"));
        await store.open("next");
      }
      detail.resolve(latest);
      await loading;
      expect(store.selected?.id ?? null).toBe(
        action === "logout" ? null : "next",
      );
    },
  );

  it("does not start private reloads after a retry completes following logout", async () => {
    const sending = deferred<unknown>();
    vi.mocked(post).mockReturnValueOnce(sending.promise);
    const store = useMailStore();
    store.selected = sent();
    const retry = store.retry(store.selected);
    store.reset();
    sending.resolve({});
    await retry;
    expect(api).not.toHaveBeenCalled();
    expect(store.selected).toBeNull();
    expect(store.error).toBe("");
  });
});
