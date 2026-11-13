import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import worker from "../src/server/index";
import { now, sessionDigest } from "../src/server/lib";

export async function mailboxRequest(path: string, init: RequestInit = {}) {
  const context = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://mail.example.com/api/v1${path}`, init),
    env,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

export async function mailboxAuthorization() {
  await env.DB.prepare(
    "INSERT INTO admins(id,email,password_hash,created_at) VALUES('admin','admin@example.com','unused',1)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO sessions(id_hash,admin_id,expires_at,created_at) VALUES(?,'admin',?,1)",
  )
    .bind(
      await sessionDigest("mailbox-session", env.SESSION_SECRET),
      now() + 3600,
    )
    .run();
  return { Cookie: "folio_session=mailbox-session" };
}

export async function seedMailbox() {
  await env.DB.prepare(
    "INSERT INTO domains(id,name,receiving_enabled,sending_enabled,created_at,updated_at) VALUES('domain','example.com',1,1,1,1)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO mailboxes(id,domain_id,local_part,email,created_at) VALUES('mailbox','domain','inbox','inbox@example.com',1)",
  ).run();
}
