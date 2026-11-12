import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Env } from "../types";
import { now } from "../lib";
import { reconcileWebhooks, webhookInput } from "../services/webhooks";

const app = new Hono<{ Bindings: Env }>();
app.use("*", bodyLimit({ maxSize: 1024 * 1024 }));
app.post("/resend", async (c) => {
  const secret = c.env.RESEND_WEBHOOK_SECRET;
  if (!secret)
    return c.json({ error: "Webhook secret is not configured" }, 503);
  const raw = await c.req.text(),
    eventId = c.req.header("svix-id"),
    timestamp = c.req.header("svix-timestamp"),
    signature = c.req.header("svix-signature");
  if (
    !eventId ||
    !timestamp ||
    !signature ||
    !/^\d+$/.test(timestamp) ||
    Math.abs(Date.now() / 1000 - Number(timestamp)) > 300
  )
    return c.json({ error: "Invalid webhook headers" }, 400);
  const keyBytes = secret.startsWith("whsec_")
    ? Uint8Array.from(atob(secret.slice(6)), (x) => x.charCodeAt(0))
    : new TextEncoder().encode(secret);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  let valid = false;
  for (const item of signature.split(" ")) {
    const [version, value] = item.split(",");
    if (version !== "v1" || !value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
      continue;
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = Uint8Array.from(atob(value), (x) => x.charCodeAt(0));
    } catch {
      continue;
    }
    if (
      await crypto.subtle.verify(
        "HMAC",
        key,
        bytes,
        new TextEncoder().encode(`${eventId}.${timestamp}.${raw}`),
      )
    )
      valid = true;
  }
  if (!valid) return c.json({ error: "Invalid webhook signature" }, 401);
  const event = webhookInput.parse(JSON.parse(raw));
  const inserted = await c.env.DB.prepare(
    `INSERT INTO webhook_events(id,event_type,payload,provider_message_id,event_timestamp,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
  )
    .bind(
      eventId,
      event.type,
      raw,
      event.data.email_id || null,
      event.created_at
        ? Date.parse(event.created_at)
        : Number(timestamp) * 1000,
      now(),
    )
    .run();
  if (event.data.email_id) await reconcileWebhooks(c.env, event.data.email_id);
  return c.json({ ok: true, duplicate: inserted.meta.changes === 0 });
});
export default app;
