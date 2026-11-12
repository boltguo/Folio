import { Hono } from "hono";
import { z } from "zod";
import type { Env, Variables } from "../types";
import { id, now } from "../lib";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT d.*,COUNT(DISTINCT b.id) mailbox_count,COUNT(DISTINCT CASE WHEN m.direction='inbound' THEN m.id END) inbound_count FROM domains d LEFT JOIN mailboxes b ON b.domain_id=d.id LEFT JOIN messages m ON m.mailbox_id=b.id GROUP BY d.id ORDER BY d.name`,
  ).all();
  return c.json(rows.results);
});
app.post("/", async (c) => {
  const { name: value } = z
    .object({ name: z.string() })
    .parse(await c.req.json());
  const name = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  if (
    !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
      name,
    )
  )
    return c.json(
      { error: "Enter a valid domain name", code: "INVALID_DOMAIN" },
      400,
    );
  const result = await c.env.DB.prepare(
    "INSERT INTO domains(id,name,status,created_at,updated_at) VALUES(?,?,'pending',?,?) ON CONFLICT(name) DO NOTHING RETURNING id",
  )
    .bind(id(), name, now(), now())
    .first();
  return result
    ? c.json({ ok: true }, 201)
    : c.json({ error: "Domain already exists", code: "DOMAIN_EXISTS" }, 409);
});
app.patch("/:id", async (c) => {
  const b = z
    .object({
      receiving_enabled: z.boolean().optional(),
      sending_enabled: z.boolean().optional(),
    })
    .strict()
    .refine((x) => Object.keys(x).length > 0, "No changes supplied")
    .parse(await c.req.json());
  const receiving =
      b.receiving_enabled == null ? null : Number(b.receiving_enabled),
    sending = b.sending_enabled == null ? null : Number(b.sending_enabled);
  const result = await c.env.DB.prepare(
    `UPDATE domains SET receiving_enabled=COALESCE(?,receiving_enabled),sending_enabled=COALESCE(?,sending_enabled),
    status=CASE WHEN COALESCE(?,receiving_enabled)=1 AND COALESCE(?,sending_enabled)=1 THEN 'active' WHEN COALESCE(?,receiving_enabled)=1 THEN 'receiving' WHEN COALESCE(?,sending_enabled)=1 THEN 'sending' ELSE 'pending' END,updated_at=? WHERE id=? RETURNING id`,
  )
    .bind(
      receiving,
      sending,
      receiving,
      sending,
      receiving,
      sending,
      now(),
      c.req.param("id"),
    )
    .first();
  return result
    ? c.json({ ok: true })
    : c.json({ error: "Domain not found", code: "NOT_FOUND" }, 404);
});
app.delete("/:id", async (c) => {
  const count = await c.env.DB.prepare(
    "SELECT COUNT(*) n FROM mailboxes WHERE domain_id=?",
  )
    .bind(c.req.param("id"))
    .first<{ n: number }>();
  if (count?.n)
    return c.json(
      {
        error: "Delete mailboxes before deleting this domain",
        code: "DOMAIN_HAS_MAILBOXES",
      },
      409,
    );
  const result = await c.env.DB.prepare(
    "DELETE FROM domains WHERE id=? RETURNING id",
  )
    .bind(c.req.param("id"))
    .first();
  return result
    ? c.json({ ok: true })
    : c.json({ error: "Domain not found", code: "NOT_FOUND" }, 404);
});
export default app;
