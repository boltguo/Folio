import type { Context, Next } from "hono";
import type { Env, Variables } from "../types";
import { sessionDigest, now } from "../lib";
const cookieName = "folio_session";
export async function requireAuth(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  next: Next,
) {
  if (!c.env.SESSION_SECRET || c.env.SESSION_SECRET.length < 32)
    return c.json(
      { error: "SESSION_SECRET is not configured", code: "SESSION_CONFIG" },
      503,
    );
  const token = c.req
    .header("Cookie")
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(cookieName + "="))
    ?.slice(cookieName.length + 1);
  if (!token)
    return c.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, 401);
  const session = await c.env.DB.prepare(
    "SELECT admin_id, expires_at FROM sessions WHERE id_hash=?",
  )
    .bind(await sessionDigest(token, c.env.SESSION_SECRET))
    .first<{ admin_id: string; expires_at: number }>();
  if (!session || session.expires_at <= now()) {
    if (session)
      await c.env.DB.prepare("DELETE FROM sessions WHERE id_hash=?")
        .bind(await sessionDigest(token, c.env.SESSION_SECRET))
        .run();
    return c.json({ error: "Session expired", code: "AUTH_REQUIRED" }, 401);
  }
  c.set("adminId", session.admin_id);
  await next();
}
export function setSessionCookie(token: string, secure: boolean) {
  return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secure ? "; Secure" : ""}`;
}
export const clearSessionCookie = (secure: boolean) =>
  `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
