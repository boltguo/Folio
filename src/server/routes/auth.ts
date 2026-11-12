import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Env, Variables } from "../types";
import {
  hashPassword,
  id,
  now,
  randomToken,
  sessionDigest,
  sha256,
  verifyPassword,
} from "../lib";
import {
  clearSessionCookie,
  setSessionCookie,
  requireAuth,
} from "../middleware/auth";
import { emailAddress, password } from "../validation";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use(
  "*",
  bodyLimit({
    maxSize: 8192,
    onError: (c) =>
      c.json({ error: "Request body is too large", code: "TOO_LARGE" }, 413),
  }),
);
app.use("*", async (c, next) => {
  if (!c.env.SESSION_SECRET || c.env.SESSION_SECRET.length < 32) {
    return c.json(
      {
        error: "Configure SESSION_SECRET with at least 32 random characters",
        code: "SESSION_CONFIG",
      },
      503,
    );
  }
  c.header("Cache-Control", "no-store");
  await next();
});
app.use("*", async (c, next) => {
  if (
    !["/api/v1/auth/login", "/api/v1/auth/change-password"].includes(
      c.req.path,
    ) ||
    c.req.method !== "POST"
  )
    return next();
  const t = now();
  const key = await sha256(
    `${c.req.path}:${c.req.header("CF-Connecting-IP") || "local"}`,
  );
  await c.env.DB.prepare("DELETE FROM login_attempts WHERE expires_at <= ?")
    .bind(t)
    .run();
  const attempt = await c.env.DB.prepare(
    `
    INSERT INTO login_attempts(key, attempts, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET attempts=attempts+1
    RETURNING attempts, expires_at
  `,
  )
    .bind(key, t + 900)
    .first<{ attempts: number; expires_at: number }>();
  if (attempt && attempt.attempts > 10) {
    c.header("Retry-After", String(Math.max(1, attempt.expires_at - t)));
    return c.json(
      {
        error: "Too many attempts. Try again in 15 minutes.",
        code: "RATE_LIMITED",
      },
      429,
    );
  }
  await next();
});

app.post("/login", async (c) => {
  const input = z
    .object({ email: emailAddress, password: z.string().min(1).max(256) })
    .parse(await c.req.json());
  const email = input.email.toLowerCase();
  let admin = await c.env.DB.prepare(
    "SELECT id,password_hash FROM admins WHERE email=?",
  )
    .bind(email)
    .first<{ id: string; password_hash: string }>();
  if (!admin) {
    const count = await c.env.DB.prepare(
      "SELECT COUNT(*) n FROM admins",
    ).first<{ n: number }>();
    if (
      count?.n === 0 &&
      email === c.env.ADMIN_EMAIL?.trim().toLowerCase() &&
      input.password === c.env.ADMIN_PASSWORD
    ) {
      password.parse(input.password);
      const adminId = id(),
        passwordHash = await hashPassword(input.password);
      await c.env.DB.prepare(
        "INSERT INTO admins(id,email,password_hash,created_at) VALUES(?,?,?,?) ON CONFLICT(email) DO NOTHING",
      )
        .bind(adminId, email, passwordHash, now())
        .run();
      admin = await c.env.DB.prepare(
        "SELECT id,password_hash FROM admins WHERE email=?",
      )
        .bind(email)
        .first<{ id: string; password_hash: string }>();
    }
  }
  if (!admin || !(await verifyPassword(input.password, admin.password_hash)))
    return c.json(
      { error: "Invalid email or password", code: "INVALID_CREDENTIALS" },
      401,
    );
  const token = randomToken(),
    t = now();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(t),
    c.env.DB.prepare(
      "INSERT INTO sessions(id_hash,admin_id,expires_at,created_at) VALUES(?,?,?,?)",
    ).bind(
      await sessionDigest(token, c.env.SESSION_SECRET),
      admin.id,
      t + 2592000,
      t,
    ),
  ]);
  c.header(
    "Set-Cookie",
    setSessionCookie(token, new URL(c.req.url).protocol === "https:"),
  );
  return c.json({ admin: { email } });
});
app.post("/logout", async (c) => {
  const token = getCookie(c, "folio_session");
  if (token)
    await c.env.DB.prepare("DELETE FROM sessions WHERE id_hash=?")
      .bind(await sessionDigest(token, c.env.SESSION_SECRET))
      .run();
  c.header(
    "Set-Cookie",
    clearSessionCookie(new URL(c.req.url).protocol === "https:"),
  );
  return c.json({ ok: true });
});
app.get("/me", requireAuth, (c) => c.json({ authenticated: true }));
app.post("/change-password", requireAuth, async (c) => {
  const input = z
    .object({
      currentPassword: z.string().min(1).max(256),
      newPassword: password,
    })
    .parse(await c.req.json());
  const admin = await c.env.DB.prepare(
    "SELECT password_hash FROM admins WHERE id=?",
  )
    .bind(c.get("adminId"))
    .first<{ password_hash: string }>();
  if (
    !admin ||
    !(await verifyPassword(input.currentPassword, admin.password_hash))
  )
    return c.json(
      { error: "Current password is incorrect", code: "CURRENT_PASSWORD" },
      400,
    );
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE admins SET password_hash=? WHERE id=?").bind(
      await hashPassword(input.newPassword),
      c.get("adminId"),
    ),
    c.env.DB.prepare("DELETE FROM sessions WHERE admin_id=?").bind(
      c.get("adminId"),
    ),
  ]);
  c.header(
    "Set-Cookie",
    clearSessionCookie(new URL(c.req.url).protocol === "https:"),
  );
  return c.json({ ok: true });
});
export default app;
