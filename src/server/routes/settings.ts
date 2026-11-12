import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { now } from "../lib";
import { findMailbox, storeInbound } from "../services/inbound";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.get("/", async (c) => {
  const stats = await c.env.DB.prepare(
    `SELECT
    (SELECT COUNT(*) FROM domains) domains,
    (SELECT COUNT(*) FROM mailboxes) mailboxes,
    (SELECT COUNT(*) FROM messages WHERE is_deleted=0) messages,
    (SELECT COUNT(*) FROM messages WHERE direction='inbound' AND is_read=0 AND is_deleted=0) unread`,
  ).first();
  const failures = await c.env.DB.prepare(
    "SELECT id,recipient,reason,raw_object_key,created_at,resolved_at FROM inbound_failures WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 20",
  ).all();
  return c.json({
    stats,
    resendConfigured: !!c.env.RESEND_API_KEY,
    webhookConfigured: !!c.env.RESEND_WEBHOOK_SECRET,
    failures: failures.results,
  });
});
app.post("/failures/:id/replay", async (c) => {
  const failure = await c.env.DB.prepare(
    "SELECT recipient,raw_object_key,reason FROM inbound_failures WHERE id=?",
  )
    .bind(c.req.param("id"))
    .first<{
      recipient: string;
      raw_object_key: string | null;
      reason: string;
    }>();
  if (!failure)
    return c.json(
      { error: "Failure record not found", code: "NOT_FOUND" },
      404,
    );
  if (failure.reason.startsWith("Forward failed"))
    return c.json(
      {
        error:
          "Original mail is saved. Check the forwarding destination and forward manually; replay does not forward mail.",
        code: "FORWARD_REPLAY",
      },
      409,
    );
  if (!failure.raw_object_key)
    return c.json(
      {
        error: "No raw mail was saved. Inspect Cloudflare routing logs.",
        code: "RAW_UNAVAILABLE",
      },
      409,
    );
  const mailbox = await findMailbox(c.env, failure.recipient);
  if (!mailbox?.enabled || !mailbox.receiving_enabled)
    return c.json(
      {
        error: "Enable the receiving mailbox before replaying",
        code: "RECEIVING_DISABLED",
      },
      409,
    );
  const raw = await c.env.MAIL_STORAGE.get(failure.raw_object_key);
  if (!raw)
    return c.json(
      { error: "Raw mail object is missing", code: "RAW_MISSING" },
      404,
    );
  const result = await storeInbound(
    c.env,
    mailbox,
    await raw.arrayBuffer(),
    raw.customMetadata?.envelopeFrom || "",
  );
  await c.env.DB.prepare(
    "UPDATE inbound_failures SET resolved_at=? WHERE raw_object_key=?",
  )
    .bind(now(), failure.raw_object_key)
    .run();
  return c.json({ ok: true, messageId: result.id });
});
app.post("/failures/:id/dismiss", async (c) => {
  const result = await c.env.DB.prepare(
    "UPDATE inbound_failures SET resolved_at=? WHERE id=? RETURNING id",
  )
    .bind(now(), c.req.param("id"))
    .first();
  return result
    ? c.json({ ok: true })
    : c.json({ error: "Failure record not found", code: "NOT_FOUND" }, 404);
});
export default app;
