import PostalMime from "postal-mime";
import type { Env } from "../types";
import { id, now, safeFilename } from "../lib";

export interface ReceivingMailbox {
  id: string;
  email: string;
  enabled: number;
  receiving_enabled: number;
  forward_enabled: number;
  forward_to: string | null;
}
export function findMailbox(env: Env, recipient: string) {
  return env.DB.prepare(
    "SELECT b.*,d.receiving_enabled FROM mailboxes b JOIN domains d ON d.id=b.domain_id WHERE b.email=?",
  )
    .bind(recipient.toLowerCase().trim())
    .first<ReceivingMailbox>();
}

async function recordFailure(
  env: Env,
  recipient: string,
  rawKey: string | null,
  reason: string,
  messageId: string | null = null,
) {
  console.error("inbound_failure", { recipient, rawKey, reason });
  try {
    await env.DB.prepare(
      "INSERT INTO inbound_failures(id,recipient,message_id,raw_object_key,reason,created_at) VALUES(?,?,?,?,?,?)",
    )
      .bind(id(), recipient, messageId, rawKey, reason.slice(0, 1000), now())
      .run();
  } catch (error) {
    console.error("inbound_failure_record_failed", { rawKey, error });
  }
}

export async function storeInbound(
  env: Env,
  mailbox: ReceivingMailbox,
  raw: ArrayBuffer,
  envelopeFrom: string,
) {
  const fingerprint = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", raw)),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  const base = `mail/${mailbox.id}/${fingerprint}`,
    rawKey = `${base}/raw.eml`;
  let messageId: string | null = null;
  try {
    const duplicateRaw = await env.DB.prepare(
      "SELECT id FROM messages WHERE mailbox_id=? AND raw_object_key=? AND direction='inbound'",
    )
      .bind(mailbox.id, rawKey)
      .first<{ id: string }>();
    if (duplicateRaw) return { id: duplicateRaw.id, duplicate: true, rawKey };
    await env.MAIL_STORAGE.put(rawKey, raw, {
      httpMetadata: { contentType: "message/rfc822" },
      customMetadata: { recipient: mailbox.email, envelopeFrom },
    });
    const parsed = await PostalMime.parse(raw, {
      maxNestingDepth: 30,
      maxHeadersSize: 1048576,
      maxRfc822NestingDepth: 3,
    });
    messageId = parsed.messageId || null;
    if (messageId) {
      const existing = await env.DB.prepare(
        "SELECT id FROM messages WHERE mailbox_id=? AND message_id=? AND direction='inbound'",
      )
        .bind(mailbox.id, messageId)
        .first<{ id: string }>();
      if (existing) return { id: existing.id, duplicate: true, rawKey };
    }
    const mid = id(),
      t = now(),
      htmlKey = parsed.html ? `${base}/body.html` : null;
    if (htmlKey)
      await env.MAIL_STORAGE.put(htmlKey, parsed.html!, {
        httpMetadata: { contentType: "text/html; charset=utf-8" },
      });
    const addressList = (items: typeof parsed.to): string[] =>
      items?.flatMap((a) =>
        "group" in a ? addressList(a.group) : a.address ? [a.address] : [],
      ) || [];
    const to = addressList(parsed.to),
      text = parsed.text || "";
    const statements = [
      env.DB.prepare(
        `
      INSERT INTO messages(id,mailbox_id,direction,message_id,in_reply_to,references_header,from_address,from_name,to_addresses,cc_addresses,bcc_addresses,subject,snippet,body_text,html_object_key,raw_object_key,status,has_attachments,received_at,created_at)
      VALUES(?,?,'inbound',?,?,?,?,?,?,?,?,?,?,?,?,?,'received',?,?,?)
    `,
      ).bind(
        mid,
        mailbox.id,
        messageId,
        parsed.inReplyTo || null,
        parsed.references || null,
        parsed.from?.address || envelopeFrom,
        parsed.from?.name || null,
        JSON.stringify(to.length ? to : [mailbox.email]),
        JSON.stringify(addressList(parsed.cc)),
        JSON.stringify(addressList(parsed.bcc)),
        parsed.subject || "(no subject)",
        text.replace(/\s+/g, " ").trim().slice(0, 220),
        text,
        htmlKey,
        rawKey,
        Number(parsed.attachments.length > 0),
        t,
        t,
      ),
    ];
    for (const [index, attachment] of parsed.attachments.entries()) {
      const filename = safeFilename(attachment.filename || "attachment"),
        key = `${base}/attachments/${index}`;
      const content =
        typeof attachment.content === "string"
          ? new TextEncoder().encode(attachment.content)
          : attachment.content;
      await env.MAIL_STORAGE.put(key, content, {
        httpMetadata: {
          contentType: attachment.mimeType || "application/octet-stream",
        },
      });
      statements.push(
        env.DB.prepare(
          "INSERT INTO attachments(id,message_id,filename,content_type,size,r2_key,content_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
        ).bind(
          id(),
          mid,
          filename,
          attachment.mimeType || "application/octet-stream",
          content.byteLength,
          key,
          attachment.contentId || null,
          t,
        ),
      );
    }
    try {
      await env.DB.batch(statements);
    } catch (error) {
      // A concurrent delivery may have committed the same message while R2 was being written.
      const existing = await env.DB.prepare(
        "SELECT id FROM messages WHERE mailbox_id=? AND direction='inbound' AND (raw_object_key=? OR message_id=?)",
      )
        .bind(mailbox.id, rawKey, messageId)
        .first<{ id: string }>();
      if (existing) return { id: existing.id, duplicate: true, rawKey };
      throw error;
    }
    return { id: mid, duplicate: false, rawKey };
  } catch (error) {
    await recordFailure(
      env,
      mailbox.email,
      rawKey,
      `Ingestion failed: ${String(error)}`,
      messageId,
    );
    throw error;
  }
}

export async function receiveEmail(message: ForwardableEmailMessage, env: Env) {
  const mailbox = await findMailbox(env, message.to);
  if (!mailbox || !mailbox.enabled || !mailbox.receiving_enabled) {
    message.setReject("This mailbox is not configured to receive mail");
    return;
  }
  const maxSize = Number(env.MAX_EMAIL_BYTES || 26214400);
  if (!Number.isSafeInteger(maxSize) || maxSize < 1)
    throw new Error("Invalid MAX_EMAIL_BYTES configuration");
  if (message.rawSize > maxSize) {
    message.setReject("Message exceeds the configured size limit");
    return;
  }
  const raw = await new Response(message.raw).arrayBuffer();
  if (raw.byteLength > maxSize) {
    message.setReject("Message exceeds the configured size limit");
    return;
  }
  const result = await storeInbound(env, mailbox, raw, message.from);
  if (!result.duplicate && mailbox.forward_enabled && mailbox.forward_to) {
    try {
      await message.forward(mailbox.forward_to);
    } catch (error) {
      await recordFailure(
        env,
        mailbox.email,
        result.rawKey,
        `Forward failed (mail is saved): ${String(error)}`,
      );
    }
  }
}
