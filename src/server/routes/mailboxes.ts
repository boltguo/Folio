import { Hono } from "hono";
import { z } from "zod";
import type { Env, Variables } from "../types";
import { id, now } from "../lib";
import { emailAddress, headerText } from "../validation";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const options = z.object({
  displayName: headerText.max(100).optional(),
  enabled: z.boolean().optional(),
  forwardEnabled: z.boolean().optional(),
  forwardTo: emailAddress.nullable().optional(),
});
app.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT b.*,d.name domain_name,d.sending_enabled domain_sending_enabled,(SELECT COUNT(*) FROM messages m WHERE m.mailbox_id=b.id AND m.direction='inbound') received_count,(SELECT COUNT(*) FROM messages m WHERE m.mailbox_id=b.id AND m.direction='inbound' AND m.is_read=0 AND m.is_deleted=0) unread_count FROM mailboxes b JOIN domains d ON d.id=b.domain_id ORDER BY d.name,b.local_part`,
  ).all();
  return c.json(rows.results);
});
app.post("/", async (c) => {
  const b = options
    .extend({
      domainId: z.string().min(1),
      localPart: z.string().trim().toLowerCase().min(1).max(64),
    })
    .parse(await c.req.json());
  const local = b.localPart;
  if (
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..")
  )
    return c.json(
      { error: "Invalid mailbox name", code: "INVALID_MAILBOX" },
      400,
    );
  const domain = await c.env.DB.prepare("SELECT name FROM domains WHERE id=?")
    .bind(b.domainId)
    .first<{ name: string }>();
  if (!domain)
    return c.json({ error: "Domain not found", code: "NOT_FOUND" }, 404);
  const email = `${local}@${domain.name}`;
  if (email.length > 254)
    return c.json(
      { error: "Mailbox address is too long", code: "MAILBOX_TOO_LONG" },
      400,
    );
  if (b.forwardEnabled && (!b.forwardTo || b.forwardTo.toLowerCase() === email))
    return c.json(
      {
        error: "A different forwarding destination is required",
        code: "FORWARD_TARGET",
      },
      400,
    );
  const result = await c.env.DB.prepare(
    "INSERT INTO mailboxes(id,domain_id,local_part,email,display_name,enabled,forward_enabled,forward_to,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING id",
  )
    .bind(
      id(),
      b.domainId,
      local,
      email,
      b.displayName || "",
      Number(b.enabled !== false),
      Number(!!b.forwardEnabled),
      b.forwardEnabled ? b.forwardTo : null,
      now(),
    )
    .first();
  return result
    ? c.json({ email }, 201)
    : c.json({ error: "Mailbox already exists", code: "MAILBOX_EXISTS" }, 409);
});
app.patch("/:id", async (c) => {
  const b = options
    .strict()
    .refine((x) => Object.keys(x).length > 0, "No changes supplied")
    .parse(await c.req.json());
  const row = await c.env.DB.prepare(
    "SELECT email,forward_enabled,forward_to FROM mailboxes WHERE id=?",
  )
    .bind(c.req.param("id"))
    .first<{
      email: string;
      forward_enabled: number;
      forward_to: string | null;
    }>();
  if (!row)
    return c.json({ error: "Mailbox not found", code: "NOT_FOUND" }, 404);
  const forwarding = b.forwardEnabled ?? !!row.forward_enabled,
    target = b.forwardTo === undefined ? row.forward_to : b.forwardTo;
  if (forwarding && (!target || target.toLowerCase() === row.email))
    return c.json(
      {
        error: "A different forwarding destination is required",
        code: "FORWARD_TARGET",
      },
      400,
    );
  await c.env.DB.prepare(
    "UPDATE mailboxes SET display_name=COALESCE(?,display_name),enabled=COALESCE(?,enabled),forward_enabled=?,forward_to=? WHERE id=?",
  )
    .bind(
      b.displayName ?? null,
      b.enabled == null ? null : Number(b.enabled),
      Number(forwarding),
      forwarding ? target : null,
      c.req.param("id"),
    )
    .run();
  return c.json({ ok: true });
});
app.delete("/:id", async (c) => {
  const count = await c.env.DB.prepare(
    "SELECT COUNT(*) n FROM messages WHERE mailbox_id=?",
  )
    .bind(c.req.param("id"))
    .first<{ n: number }>();
  if (count?.n)
    return c.json(
      {
        error:
          "This mailbox contains mail. Disable it instead to preserve its history.",
        code: "MAILBOX_HAS_MAIL",
      },
      409,
    );
  const result = await c.env.DB.prepare(
    "DELETE FROM mailboxes WHERE id=? RETURNING id",
  )
    .bind(c.req.param("id"))
    .first();
  return result
    ? c.json({ ok: true })
    : c.json({ error: "Mailbox not found", code: "NOT_FOUND" }, 404);
});
export default app;
