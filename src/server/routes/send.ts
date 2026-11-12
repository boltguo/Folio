import { Hono, type Context } from "hono";
import type { Env, Variables } from "../types";
import { id, now, safeFilename, sha256 } from "../lib";
import { sendInput } from "../validation";
import {
  getResendMessageId,
  ResendError,
  sendWithResend,
  type SendPayload,
} from "../services/resend";
import { reconcileWebhooks } from "../services/webhooks";

type AppEnv = { Bindings: Env; Variables: Variables };
interface SendRecord {
  id: string;
  message_id: string;
  idempotency_key: string;
  payload_hash: string;
  payload_key: string;
  created_at: number;
  status: string;
  provider_message_id: string | null;
}
interface StoredSend {
  mailboxId: string;
  payload: SendPayload;
}
const app = new Hono<AppEnv>();
const findRecord = (env: Env, key: string) =>
  env.DB.prepare(
    `SELECT l.*,m.status,m.provider_message_id FROM send_logs l JOIN messages m ON m.id=l.message_id WHERE l.idempotency_key=?`,
  )
    .bind(key)
    .first<SendRecord>();
const accepted = (record: SendRecord) => !!record.provider_message_id;

async function deliver(c: Context<AppEnv>, record: SendRecord) {
  if (accepted(record))
    return c.json({
      id: record.message_id,
      status: record.status,
      providerMessageId: record.provider_message_id,
      duplicate: true,
    });
  if (!c.env.RESEND_API_KEY)
    return c.json(
      { error: "RESEND_API_KEY is not configured", code: "RESEND_CONFIG" },
      503,
    );
  // Resend retains idempotency keys for 24 hours. Stop early instead of risking another delivery.
  if (now() - record.created_at >= 23 * 3600)
    return c.json(
      {
        error:
          "Safe retry window expired. Check the Resend dashboard before creating a new email.",
        code: "RETRY_EXPIRED",
      },
      409,
    );
  const object = await c.env.MAIL_STORAGE.get(record.payload_key);
  if (!object) throw new Error("Stored send payload is missing");
  const raw = await object.text();
  if ((await sha256(raw)) !== record.payload_hash)
    throw new Error("Stored send payload checksum mismatch");
  const stored: StoredSend = JSON.parse(raw);
  const sender = await c.env.DB.prepare(
    "SELECT b.enabled,d.sending_enabled FROM mailboxes b JOIN domains d ON d.id=b.domain_id WHERE b.id=?",
  )
    .bind(stored.mailboxId)
    .first<{ enabled: number; sending_enabled: number }>();
  if (!sender?.enabled || !sender.sending_enabled)
    return c.json(
      {
        error: "Sender mailbox or domain is not enabled for sending",
        code: "SENDER_DISABLED",
      },
      400,
    );
  const t = now();
  const claim = await c.env.DB.prepare(
    `UPDATE send_logs SET lease_until=?,attempted_at=COALESCE(attempted_at,?) WHERE id=? AND lease_until<=? AND provider_message_id IS NULL RETURNING id`,
  )
    .bind(t + 120, t, record.id, t)
    .first();
  if (!claim)
    return c.json(
      {
        error:
          "This email is already being submitted. Wait two minutes, then retry the same email.",
        code: "SEND_BUSY",
        messageId: record.message_id,
      },
      409,
    );
  let providerId: string;
  try {
    providerId = await sendWithResend(
      c.env,
      stored.payload,
      record.idempotency_key,
    );
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "Unknown sending error";
    const status =
      error instanceof ResendError && !error.uncertain ? "failed" : "unknown";
    console.error("send_not_confirmed", {
      messageId: record.message_id,
      status,
      reason,
    });
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE messages SET status=? WHERE id=? AND provider_message_id IS NULL",
      ).bind(status, record.message_id),
      c.env.DB.prepare(
        "UPDATE send_logs SET status=?,error_message=?,lease_until=0 WHERE id=? AND provider_message_id IS NULL",
      ).bind(status, reason.slice(0, 1000), record.id),
    ]);
    return c.json(
      {
        error: `${reason}. Retry this same email; do not create a second copy.`,
        code: "SEND_UNCONFIRMED",
        details: reason,
        messageId: record.message_id,
        status,
      },
      502,
    );
  }
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE messages SET status='sent',provider_message_id=? WHERE id=? AND provider_message_id IS NULL",
      ).bind(providerId, record.message_id),
      c.env.DB.prepare(
        "UPDATE send_logs SET status='sent',provider_message_id=?,error_message=NULL,lease_until=0 WHERE id=?",
      ).bind(providerId, record.id),
    ]);
  } catch (error) {
    console.error("accepted_send_persistence_failed", {
      messageId: record.message_id,
      providerId,
      error,
    });
    return c.json(
      {
        error:
          "Resend accepted this email but local confirmation failed. Retry the same email after two minutes; do not create a new copy.",
        code: "SEND_PERSISTENCE",
        messageId: record.message_id,
        status: "unknown",
      },
      502,
    );
  }
  try {
    const messageId = await getResendMessageId(c.env, providerId);
    if (messageId)
      await c.env.DB.prepare("UPDATE messages SET message_id=? WHERE id=?")
        .bind(messageId, record.message_id)
        .run();
  } catch (error) {
    console.warn("sent_message_id_lookup_failed", { providerId, error });
  }
  await reconcileWebhooks(c.env, providerId);
  const result = await c.env.DB.prepare(
    "SELECT status FROM messages WHERE id=?",
  )
    .bind(record.message_id)
    .first<{ status: string }>();
  return c.json({
    id: record.message_id,
    status: result!.status,
    providerMessageId: providerId,
  });
}

app.post("/", async (c) => {
  const b = sendInput.parse(await c.req.json());
  if (!c.env.RESEND_API_KEY)
    return c.json(
      { error: "RESEND_API_KEY is not configured", code: "RESEND_CONFIG" },
      503,
    );
  const clientKey = c.req.header("Idempotency-Key")?.trim();
  if (!clientKey || clientKey.length > 200)
    return c.json(
      {
        error: "An Idempotency-Key header of 1-200 characters is required",
        code: "INVALID_SEND_KEY",
      },
      400,
    );
  const mailbox = await c.env.DB.prepare(
    "SELECT b.email,b.display_name,b.enabled,d.sending_enabled FROM mailboxes b JOIN domains d ON d.id=b.domain_id WHERE b.id=?",
  )
    .bind(b.mailboxId)
    .first<{
      email: string;
      display_name: string;
      enabled: number;
      sending_enabled: number;
    }>();
  if (!mailbox?.enabled || !mailbox.sending_enabled)
    return c.json(
      {
        error: "Sender mailbox or domain is not enabled for sending",
        code: "SENDER_DISABLED",
      },
      400,
    );
  const headers: Record<string, string> = {};
  if (b.inReplyTo) headers["In-Reply-To"] = b.inReplyTo;
  if (b.references) headers.References = b.references;
  const payload: SendPayload = {
    from: mailbox.display_name
      ? `${JSON.stringify(mailbox.display_name)} <${mailbox.email}>`
      : mailbox.email,
    to: b.to,
    cc: b.cc,
    bcc: b.bcc,
    subject: b.subject || "(no subject)",
    text: b.text,
    html: b.html,
    reply_to: b.replyTo,
    headers,
    attachments: b.attachments.map((a) => ({
      filename: safeFilename(a.filename),
      content: a.content,
      content_type: a.contentType,
    })),
  };
  const raw = JSON.stringify({
      mailboxId: b.mailboxId,
      payload,
    } satisfies StoredSend),
    hash = await sha256(raw);
  const key = `folio/${await sha256(clientKey)}`;
  const prior = await findRecord(c.env, key);
  if (prior) {
    if (prior.payload_hash !== hash)
      return c.json(
        {
          error: "This idempotency key already belongs to a different email",
          code: "SEND_KEY_CONFLICT",
        },
        409,
      );
    return deliver(c, prior);
  }
  const mid = id(),
    logId = id(),
    t = now(),
    base = `outbox/${await sha256(key)}/${hash}`,
    payloadKey = `${base}/payload.json`;
  await c.env.MAIL_STORAGE.put(payloadKey, raw, {
    httpMetadata: { contentType: "application/json" },
  });
  const htmlKey = b.html ? `${base}/body.html` : null;
  if (htmlKey)
    await c.env.MAIL_STORAGE.put(htmlKey, b.html!, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
    });
  const statements = [
    c.env.DB.prepare(
      `INSERT INTO messages(id,mailbox_id,direction,in_reply_to,references_header,from_address,from_name,to_addresses,cc_addresses,bcc_addresses,subject,snippet,body_text,html_object_key,status,has_attachments,is_read,received_at,created_at)
      VALUES(?,?,'outbound',?,?,?,?,?,?,?,?,?,?,?,'pending',?,1,?,?)`,
    ).bind(
      mid,
      b.mailboxId,
      b.inReplyTo || null,
      b.references || null,
      mailbox.email,
      mailbox.display_name || null,
      JSON.stringify(b.to),
      JSON.stringify(b.cc),
      JSON.stringify(b.bcc),
      payload.subject,
      (b.text || "").slice(0, 220),
      b.text || null,
      htmlKey,
      Number(b.attachments.length > 0),
      t,
      t,
    ),
    c.env.DB.prepare(
      "INSERT INTO send_logs(id,message_id,status,idempotency_key,payload_hash,payload_key,created_at) VALUES(?,?,'pending',?,?,?,?)",
    ).bind(logId, mid, key, hash, payloadKey, t),
  ];
  for (const [index, a] of payload.attachments.entries()) {
    const bytes = Uint8Array.from(atob(a.content), (x) => x.charCodeAt(0)),
      objectKey = `${base}/attachments/${index}`;
    await c.env.MAIL_STORAGE.put(objectKey, bytes, {
      httpMetadata: { contentType: a.content_type },
    });
    statements.push(
      c.env.DB.prepare(
        "INSERT INTO attachments(id,message_id,filename,content_type,size,r2_key,created_at) VALUES(?,?,?,?,?,?,?)",
      ).bind(
        id(),
        mid,
        a.filename,
        a.content_type,
        bytes.byteLength,
        objectKey,
        t,
      ),
    );
  }
  try {
    await c.env.DB.batch(statements);
  } catch (error) {
    const concurrent = await findRecord(c.env, key);
    if (!concurrent) throw error;
    if (concurrent.payload_hash !== hash)
      return c.json(
        {
          error: "This idempotency key already belongs to a different email",
          code: "SEND_KEY_CONFLICT",
        },
        409,
      );
    return deliver(c, concurrent);
  }
  return deliver(c, {
    id: logId,
    message_id: mid,
    idempotency_key: key,
    payload_hash: hash,
    payload_key: payloadKey,
    created_at: t,
    status: "pending",
    provider_message_id: null,
  });
});
app.post("/:id/retry", async (c) => {
  const record = await c.env.DB.prepare(
    `SELECT l.*,m.status,m.provider_message_id FROM send_logs l JOIN messages m ON m.id=l.message_id WHERE m.id=?`,
  )
    .bind(c.req.param("id"))
    .first<SendRecord>();
  if (!record)
    return c.json({ error: "Sent message not found", code: "NOT_FOUND" }, 404);
  return deliver(c, record);
});
export default app;
