import type { MessageDetail } from "../../shared/types";

export type ComposeMode = "new" | "reply" | "replyAll" | "forward";

export function replyRecipients(message: MessageDetail): string[] {
  if (message.direction === "outbound") return message.to_addresses;
  return message.reply_to_addresses.length
    ? message.reply_to_addresses
    : [message.from_address];
}

export function replyAllRecipients(
  message: MessageDetail,
  ownAddresses: string[],
): { to: string[]; cc: string[] } {
  const excluded = new Set(
    ownAddresses.map((address) => address.trim().toLowerCase()),
  );
  const take = (addresses: string[]) =>
    addresses.filter((address) => {
      const normalized = address.trim().toLowerCase();
      if (!normalized || excluded.has(normalized)) return false;
      excluded.add(normalized);
      return true;
    });
  const to = take([...replyRecipients(message), ...message.to_addresses]);
  const cc = take(message.cc_addresses);
  // Sending requires a To recipient. After removing owned addresses, a sent
  // conversation may have only external Cc recipients left.
  if (!to.length && cc.length) to.push(cc.shift()!);
  return { to, cc };
}

/** Read a detached template; no email nodes or remote resources enter the page. */
export function htmlToPlainText(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  const content = template.content;
  content
    .querySelectorAll("script, style, head, title, noscript, iframe, object")
    .forEach((node) => node.remove());
  content.querySelectorAll("a[href]").forEach((link) => {
    const href = link.getAttribute("href") || "";
    if (/^(https?:|mailto:)/i.test(href) && link.textContent?.trim() !== href)
      link.append(` <${href}>`);
  });
  content.querySelectorAll("img").forEach((image) => {
    image.replaceWith(document.createTextNode(image.getAttribute("alt") || ""));
  });
  content.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
  content.querySelectorAll("td, th").forEach((node) => node.append("\t"));
  content
    .querySelectorAll(
      "p, div, section, article, blockquote, h1, h2, h3, h4, h5, h6, li, tr, pre, hr",
    )
    .forEach((node) => node.append("\n\n"));
  return Array.from(content.childNodes, (node) => node.textContent || "")
    .join("")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n[\t ]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function quoteMessage(
  message: MessageDetail,
  labels: {
    original: string;
    from: string;
    date: string;
    to: string;
    cc: string;
    subject: string;
  },
  formattedDate: string,
  extractHtml = htmlToPlainText,
): string {
  const body = message.body_text?.trim()
    ? message.body_text
    : message.body_html
      ? extractHtml(message.body_html)
      : "";
  const sender = message.from_name
    ? `${message.from_name} <${message.from_address}>`
    : message.from_address;
  const headers = [
    `--- ${labels.original} ---`,
    `${labels.from}: ${sender}`,
    `${labels.date}: ${formattedDate}`,
    `${labels.to}: ${message.to_addresses.join(", ")}`,
    ...(message.cc_addresses.length
      ? [`${labels.cc}: ${message.cc_addresses.join(", ")}`]
      : []),
    `${labels.subject}: ${message.subject}`,
  ];
  return `\n\n${headers.join("\n")}\n\n${body}`;
}

const messageIds = (value: string | null) =>
  value?.match(/<[^<>\s\u0000-\u001f\u007f]+>/g) || [];

/** Keep the thread root and the most recent IDs within the API/header budget. */
export function replyThreadHeaders(
  message: Pick<MessageDetail, "message_id" | "references_header">,
) {
  const limit = 998;
  const inReplyTo =
    messageIds(message.message_id).find((id) => id.length <= limit) || "";
  const ids = [
    ...new Set([
      ...messageIds(message.references_header).filter(
        (id) => id.length <= limit,
      ),
      ...(inReplyTo ? [inReplyTo] : []),
    ]),
  ];
  if (ids.join(" ").length <= limit)
    return { inReplyTo, references: ids.join(" ") };
  const root = ids[0];
  const recent: string[] = [];
  let length = root.length;
  for (let index = ids.length - 1; index > 0; index--) {
    const nextLength = length + 1 + ids[index].length;
    if (nextLength > limit) {
      // An unusually large ID can make root + latest impossible; keep the latest.
      if (!recent.length) return { inReplyTo, references: ids[index] };
      break;
    }
    recent.unshift(ids[index]);
    length = nextLength;
  }
  return { inReplyTo, references: [root, ...recent].join(" ") };
}
