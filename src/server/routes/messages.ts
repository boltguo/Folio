import { Hono } from "hono";
import { z } from "zod";
import type { Env, Variables } from "../types";
import type {
  Attachment,
  MailMessage,
  MessageDetail,
  RecipientDelivery,
} from "../../shared/types";
import { parseList } from "../lib";
import { emailAddresses, parseEmail } from "../services/mime";

type MessageRow = Omit<MailMessage, "to_addresses" | "cc_addresses"> & {
  to_addresses: string;
  cc_addresses: string;
};
type DetailRow = MessageRow &
  Omit<
    MessageDetail,
    | keyof MailMessage
    | "bcc_addresses"
    | "reply_to_addresses"
    | "attachments"
    | "body_html"
    | "deliveries"
  > & {
    bcc_addresses: string;
    reply_to_addresses: string | null;
    text_object_key: string | null;
    html_object_key: string | null;
    raw_object_key: string | null;
  };
const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.get("/", async (c) => {
  const q = z
    .object({
      folder: z
        .enum(["inbox", "sent", "starred", "archive", "trash"])
        .default("inbox"),
      mailbox: z.string().optional(),
      domain: z.string().optional(),
      unread: z.enum(["0", "1"]).optional(),
      q: z.string().max(200).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).max(1000000).default(0),
    })
    .parse(c.req.query());
  const where = [q.folder === "trash" ? "m.is_deleted=1" : "m.is_deleted=0"],
    args: (string | number)[] = [];
  if (q.folder === "sent") where.push("m.direction='outbound'");
  if (q.folder === "starred") where.push("m.is_starred=1");
  if (q.folder === "archive") where.push("m.is_archived=1");
  if (q.folder === "inbox")
    where.push("m.direction='inbound' AND m.is_archived=0");
  if (q.mailbox) {
    where.push("m.mailbox_id=?");
    args.push(q.mailbox);
  }
  if (q.domain) {
    where.push("d.id=?");
    args.push(q.domain);
  }
  if (q.unread === "1") where.push("m.is_read=0");
  if (q.q) {
    where.push(
      `(instr(lower(m.subject),lower(?))>0
        OR instr(lower(m.from_address),lower(?))>0
        OR instr(lower(COALESCE(m.from_name,'')),lower(?))>0
        OR instr(lower(m.snippet),lower(?))>0
        OR EXISTS (SELECT 1 FROM json_each(m.to_addresses) WHERE instr(lower(value),lower(?))>0)
        OR EXISTS (SELECT 1 FROM json_each(m.cc_addresses) WHERE instr(lower(value),lower(?))>0)
        OR EXISTS (SELECT 1 FROM json_each(m.bcc_addresses) WHERE instr(lower(value),lower(?))>0)
        OR m.id IN (SELECT message_id FROM attachments WHERE instr(lower(filename),lower(?))>0))`,
    );
    args.push(...Array<string>(8).fill(q.q));
  }
  const from = `FROM messages m LEFT JOIN mailboxes b ON b.id=m.mailbox_id LEFT JOIN domains d ON d.id=b.domain_id WHERE ${where.join(" AND ")}`;
  const rows = await c.env.DB.prepare(
    `SELECT m.id,m.direction,m.from_address,m.from_name,m.to_addresses,m.cc_addresses,m.subject,m.snippet,m.status,m.is_read,m.is_starred,m.is_archived,m.is_deleted,m.has_attachments,m.received_at,b.email mailbox_email,d.name domain_name ${from} ORDER BY m.received_at DESC,m.id DESC LIMIT ? OFFSET ?`,
  )
    .bind(...args, q.limit, q.offset)
    .all<MessageRow>();
  const total = await c.env.DB.prepare(`SELECT COUNT(*) n ${from}`)
    .bind(...args)
    .first<{ n: number }>();
  return c.json({
    items: rows.results.map((m) => ({
      ...m,
      to_addresses: parseList(m.to_addresses),
      cc_addresses: parseList(m.cc_addresses),
    })),
    total: total!.n,
    limit: q.limit,
    offset: q.offset,
  });
});
app.get("/:id", async (c) => {
  const m = await c.env.DB.prepare(
    `SELECT m.*,b.email mailbox_email,d.name domain_name,l.error_message send_error FROM messages m LEFT JOIN mailboxes b ON b.id=m.mailbox_id LEFT JOIN domains d ON d.id=b.domain_id LEFT JOIN send_logs l ON l.message_id=m.id WHERE m.id=?`,
  )
    .bind(c.req.param("id"))
    .first<DetailRow>();
  if (!m) return c.json({ error: "Message not found", code: "NOT_FOUND" }, 404);
  const attachments = await c.env.DB.prepare(
    "SELECT id,filename,content_type,size FROM attachments WHERE message_id=?",
  )
    .bind(m.id)
    .all<Attachment>();
  const deliveries =
    m.direction === "outbound"
      ? (
          await c.env.DB.prepare(
            `SELECT address,recipient_type,status,status_updated_at,error_code,error_message,complained_at
         FROM message_deliveries WHERE message_id=?
         ORDER BY CASE recipient_type WHEN 'to' THEN 0 WHEN 'cc' THEN 1 ELSE 2 END,address`,
          )
            .bind(m.id)
            .all<RecipientDelivery>()
        ).results
      : [];
  const html = m.html_object_key
    ? await c.env.MAIL_STORAGE.get(m.html_object_key)
    : null;
  if (m.html_object_key && !html)
    throw new Error("Message HTML object is missing");
  const text = m.text_object_key
    ? await c.env.MAIL_STORAGE.get(m.text_object_key)
    : null;
  if (m.text_object_key && !text)
    throw new Error("Message text object is missing");
  let replyTo = parseList(m.reply_to_addresses);
  if (
    m.reply_to_addresses === null &&
    m.direction === "inbound" &&
    m.raw_object_key
  ) {
    // Recover Reply-To for mail received before this field was persisted.
    // A missing/corrupt legacy raw object must not hide the saved body.
    try {
      const raw = await c.env.MAIL_STORAGE.get(m.raw_object_key);
      if (raw) replyTo = emailAddresses((await parseEmail(raw.body)).replyTo);
    } catch (error) {
      console.warn("legacy_reply_to_lookup_failed", { messageId: m.id, error });
    }
  }
  return c.json({
    ...m,
    to_addresses: parseList(m.to_addresses),
    cc_addresses: parseList(m.cc_addresses),
    bcc_addresses: parseList(m.bcc_addresses),
    reply_to_addresses: replyTo,
    attachments: attachments.results,
    deliveries,
    body_text: text ? await text.text() : m.body_text,
    body_html: html ? await html.text() : null,
  });
});
app.patch("/:id", async (c) => {
  const b = z
    .object({
      isRead: z.boolean().optional(),
      isStarred: z.boolean().optional(),
      isArchived: z.boolean().optional(),
      isDeleted: z.boolean().optional(),
    })
    .strict()
    .refine((x) => Object.keys(x).length > 0, "No changes supplied")
    .parse(await c.req.json());
  const result = await c.env.DB.prepare(
    "UPDATE messages SET is_read=COALESCE(?,is_read),is_starred=COALESCE(?,is_starred),is_archived=COALESCE(?,is_archived),is_deleted=COALESCE(?,is_deleted) WHERE id=? RETURNING id",
  )
    .bind(
      b.isRead == null ? null : Number(b.isRead),
      b.isStarred == null ? null : Number(b.isStarred),
      b.isArchived == null ? null : Number(b.isArchived),
      b.isDeleted == null ? null : Number(b.isDeleted),
      c.req.param("id"),
    )
    .first();
  return result
    ? c.json({ ok: true })
    : c.json({ error: "Message not found", code: "NOT_FOUND" }, 404);
});
app.delete("/:id", async (c) => {
  const result = await c.env.DB.prepare(
    "UPDATE messages SET is_deleted=1 WHERE id=? RETURNING id",
  )
    .bind(c.req.param("id"))
    .first();
  return result
    ? c.json({ ok: true })
    : c.json({ error: "Message not found", code: "NOT_FOUND" }, 404);
});
app.get("/attachments/:id", async (c) => {
  const a = await c.env.DB.prepare(
    "SELECT filename,content_type,r2_key FROM attachments WHERE id=?",
  )
    .bind(c.req.param("id"))
    .first<{ filename: string; content_type: string; r2_key: string }>();
  if (!a)
    return c.json({ error: "Attachment not found", code: "NOT_FOUND" }, 404);
  const object = await c.env.MAIL_STORAGE.get(a.r2_key);
  if (!object) throw new Error("Attachment object is missing");
  return new Response(object.body, {
    headers: {
      "Content-Type": a.content_type,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
export default app;
