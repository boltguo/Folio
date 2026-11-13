import { afterEach, describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import {
  quoteMessage,
  htmlToPlainText,
  replyAllRecipients,
  replyThreadHeaders,
} from "../src/client/lib/compose";
import type { MessageDetail } from "../src/shared/types";

afterEach(() => vi.unstubAllGlobals());

const message = (changes: Partial<MessageDetail> = {}) =>
  ({
    direction: "inbound",
    from_address: "author@example.net",
    from_name: "Author",
    to_addresses: ["me@personal.example", "Colleague@example.net"],
    cc_addresses: [
      "me@work.example",
      "colleague@example.net",
      "friend@example.net",
    ],
    bcc_addresses: ["private@example.net"],
    reply_to_addresses: ["support@example.net"],
    subject: "A shared topic",
    body_text: "Plain original content",
    body_html: null,
    ...changes,
  }) as MessageDetail;

describe("reply all", () => {
  it("respects Reply-To, removes all owned addresses, and deduplicates To/Cc without exposing Bcc", () => {
    expect(
      replyAllRecipients(message(), ["ME@personal.example", "me@work.example"]),
    ).toEqual({
      to: ["support@example.net", "Colleague@example.net"],
      cc: ["friend@example.net"],
    });
  });
  it("uses From only when no Reply-To exists", () => {
    expect(
      replyAllRecipients(message({ reply_to_addresses: [] }), [
        "me@personal.example",
        "me@work.example",
      ]).to[0],
    ).toBe("author@example.net");
  });
  it("continues sent group conversations using original To/Cc and never its Reply-To or Bcc", () => {
    expect(
      replyAllRecipients(
        message({
          direction: "outbound",
          reply_to_addresses: ["my-support@work.example"],
        }),
        ["me@personal.example", "me@work.example"],
      ),
    ).toEqual({
      to: ["Colleague@example.net"],
      cc: ["friend@example.net"],
    });
  });
  it("promotes the first remaining Cc when all original To recipients are owned addresses", () => {
    expect(
      replyAllRecipients(
        message({
          direction: "outbound",
          to_addresses: ["me@personal.example"],
          cc_addresses: [
            "me@work.example",
            "colleague@example.net",
            "friend@example.net",
          ],
        }),
        ["me@personal.example", "me@work.example"],
      ),
    ).toEqual({
      to: ["colleague@example.net"],
      cc: ["friend@example.net"],
    });
  });
});

describe("quoted mail", () => {
  const labels = {
    original: "Original message",
    from: "From",
    date: "Date",
    to: "To",
    cc: "Cc",
    subject: "Subject",
  };
  it("uses the HTML fallback for HTML-only mail and includes ordinary original headers without Bcc", () => {
    const convert = vi.fn(() => "Invoice total: 12.00\nPayment due tomorrow");
    const quote = quoteMessage(
      message({
        body_text: "",
        body_html: "<p>Invoice total: 12.00</p><p>Payment due tomorrow</p>",
      }),
      labels,
      "Nov 13, 2026",
      convert,
    );
    expect(convert).toHaveBeenCalledWith(
      "<p>Invoice total: 12.00</p><p>Payment due tomorrow</p>",
    );
    expect(quote).toContain("Invoice total: 12.00\nPayment due tomorrow");
    expect(quote).toContain("From: Author <author@example.net>");
    expect(quote).toContain("Date: Nov 13, 2026");
    expect(quote).toContain("Subject: A shared topic");
    expect(quote).not.toContain("private@example.net");
  });
  it("keeps a provided text alternative instead of deriving a new one", () => {
    const convert = vi.fn();
    expect(
      quoteMessage(
        message({ body_html: "<p>HTML</p>" }),
        labels,
        "Today",
        convert,
      ),
    ).toContain("Plain original content");
    expect(convert).not.toHaveBeenCalled();
  });
  it("extracts actual HTML-only content, paragraph breaks, entities and links without scripts or remote images", () => {
    vi.stubGlobal(
      "document",
      parseHTML("<!doctype html><html><body></body></html>").document,
    );
    const html =
      '<html><head><style>.hidden{display:none}</style></head><body><p>Invoice &amp; receipt</p><p>Total: <b>12.00</b><br>Due tomorrow</p><a href="https://billing.example/invoice">View invoice</a><img src="https://tracking.example/pixel" alt="Invoice logo"><script>doNotQuote()</script></body></html>';
    const text = htmlToPlainText(html);
    expect(text).toContain("Invoice & receipt\n\nTotal: 12.00\nDue tomorrow");
    expect(text).toContain("View invoice <https://billing.example/invoice>");
    expect(text).toContain("Invoice logo");
    expect(text).not.toContain("tracking.example");
    expect(text).not.toContain("doNotQuote");
    expect(text).not.toContain("display:none");
    expect(
      quoteMessage(
        message({ body_text: null, body_html: html }),
        labels,
        "Today",
      ),
    ).toContain(text);
  });
});

describe("reply reference headers", () => {
  it("retains the root and most recent messages within the 998-character limit", () => {
    const ids = Array.from(
      { length: 100 },
      (_, index) => `<message-${index}@thread.example>`,
    );
    const result = replyThreadHeaders({
      message_id: "<current@thread.example>",
      references_header: ids.join(" "),
    });
    expect(result.inReplyTo).toBe("<current@thread.example>");
    expect(result.references.length).toBeLessThanOrEqual(998);
    expect(result.references.startsWith(ids[0])).toBe(true);
    expect(
      result.references.endsWith(`${ids.at(-1)} <current@thread.example>`),
    ).toBe(true);
    expect(result.references).not.toContain(ids[1]);
  });
  it("normalizes folded headers and removes repeated IDs", () => {
    expect(
      replyThreadHeaders({
        message_id: "<latest@example.net>",
        references_header:
          "<root@example.net>\r\n <latest@example.net> <root@example.net>",
      }),
    ).toEqual({
      inReplyTo: "<latest@example.net>",
      references: "<root@example.net> <latest@example.net>",
    });
  });
  it("does not let malformed or oversized original IDs make a new reply unsendable", () => {
    const result = replyThreadHeaders({
      message_id: `<${"x".repeat(1000)}@example.net>`,
      references_header: "<root@example.net>\r\nInjected: header",
    });
    expect(result).toEqual({ inReplyTo: "", references: "<root@example.net>" });
  });
});
