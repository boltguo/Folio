import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import type { Env, Variables } from "./types";
import { requireAuth } from "./middleware/auth";
import { receiveEmail } from "./services/inbound";
import auth from "./routes/auth";
import domains from "./routes/domains";
import mailboxes from "./routes/mailboxes";
import messages from "./routes/messages";
import send from "./routes/send";
import settings from "./routes/settings";
import webhooks from "./routes/webhooks";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use(
  "/api/*",
  cors({
    origin: (origin, c) =>
      origin === (c.env.APP_ORIGIN || new URL(c.req.url).origin) ? origin : "",
    credentials: true,
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Idempotency-Key"],
  }),
);
app.use("/api/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  const origin = c.req.header("Origin");
  if (
    ["POST", "PATCH", "PUT", "DELETE"].includes(c.req.method) &&
    c.req.path !== "/api/v1/webhooks/resend" &&
    origin &&
    origin !== (c.env.APP_ORIGIN || new URL(c.req.url).origin)
  )
    return c.json(
      { error: "Invalid request origin", code: "INVALID_ORIGIN" },
      403,
    );
  await next();
});
app.get("/api/health", (c) => c.json({ ok: true, service: "folio" }));
app.route("/api/v1/auth", auth);
app.route("/api/v1/webhooks", webhooks);
app.use("/api/v1/*", requireAuth);
app.use(
  "/api/v1/*",
  bodyLimit({
    maxSize: 16 * 1024 * 1024,
    onError: (c) =>
      c.json({ error: "Request body is too large", code: "TOO_LARGE" }, 413),
  }),
);
app.route("/api/v1/domains", domains);
app.route("/api/v1/mailboxes", mailboxes);
app.route("/api/v1/messages", messages);
app.route("/api/v1/send", send);
app.route("/api/v1/settings", settings);
app.get("/api/v1/sent", (c) => c.redirect("/api/v1/messages?folder=sent"));
app.notFound((c) =>
  c.req.path.startsWith("/api/")
    ? c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
    : c.env.ASSETS.fetch(c.req.raw),
);
app.onError((error, c) => {
  if (error instanceof ZodError) {
    const details = error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    return c.json(
      {
        code: "INVALID_INPUT",
        error: details,
        details,
      },
      400,
    );
  }
  if (error instanceof SyntaxError)
    return c.json({ error: "Invalid JSON", code: "INVALID_JSON" }, 400);
  if (error instanceof HTTPException) return error.getResponse();
  console.error("request_error", error);
  return c.json(
    {
      error: "Internal server error. Check Worker logs.",
      code: "INTERNAL_ERROR",
    },
    500,
  );
});
export default { fetch: app.fetch.bind(app), email: receiveEmail };
