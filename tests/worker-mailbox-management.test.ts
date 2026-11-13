import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/server/index";
import { now, sessionDigest } from "../src/server/lib";

async function request(path: string, headers: HeadersInit, database = env.DB) {
  const context = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://mail.example.com/api/v1${path}`, {
      method: "DELETE",
      headers,
    }),
    { ...env, DB: database },
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

async function authorize() {
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

async function seedDomain() {
  await env.DB.prepare(
    "INSERT INTO domains(id,name,created_at,updated_at) VALUES('domain','example.com',1,1)",
  ).run();
}

async function seedMailbox() {
  await env.DB.prepare(
    "INSERT INTO mailboxes(id,domain_id,local_part,email,created_at) VALUES('mailbox','domain','inbox','inbox@example.com',1)",
  ).run();
}

async function receiveMessage(deleted = false) {
  await env.DB.prepare(
    "INSERT INTO messages(id,mailbox_id,direction,from_address,is_deleted,received_at,created_at) VALUES('message','mailbox','inbound','sender@example.net',?,1,1)",
  )
    .bind(Number(deleted))
    .run();
}

// Place a real D1 write immediately before the DELETE executes. This models
// an incoming message or another tab creating a mailbox between API awaits.
function beforeDelete(table: string, interleave: () => Promise<void>) {
  function wrap(statement: D1PreparedStatement): D1PreparedStatement {
    return new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...args: unknown[]) => wrap(target.bind(...args));
        if (property === "first")
          return async (...args: Parameters<D1PreparedStatement["first"]>) => {
            await interleave();
            return target.first(...args);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  return new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => {
          const statement = target.prepare(sql);
          return sql.trimStart().startsWith(`DELETE FROM ${table} `)
            ? wrap(statement)
            : statement;
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("safe mailbox and domain removal", () => {
  it("removes empty resources and reports missing resources", async () => {
    const headers = await authorize();
    await seedDomain();
    await seedMailbox();
    expect((await request("/mailboxes/mailbox", headers)).status).toBe(200);
    expect((await request("/mailboxes/mailbox", headers)).status).toBe(404);
    expect((await request("/domains/domain", headers)).status).toBe(200);
    expect((await request("/domains/domain", headers)).status).toBe(404);
  });

  it("preserves mailboxes containing recoverable trash and their domains", async () => {
    const headers = await authorize();
    await seedDomain();
    await seedMailbox();
    await receiveMessage(true);
    const mailboxResponse = await request("/mailboxes/mailbox", headers);
    expect(mailboxResponse.status).toBe(409);
    expect((await mailboxResponse.json<{ code: string }>()).code).toBe(
      "MAILBOX_HAS_MAIL",
    );
    const domainResponse = await request("/domains/domain", headers);
    expect(domainResponse.status).toBe(409);
    expect((await domainResponse.json<{ code: string }>()).code).toBe(
      "DOMAIN_HAS_MAILBOXES",
    );
  });

  it("keeps a newly received message attached to its mailbox during deletion", async () => {
    const headers = await authorize();
    await seedDomain();
    await seedMailbox();
    const response = await request(
      "/mailboxes/mailbox",
      headers,
      beforeDelete("mailboxes", () => receiveMessage()),
    );
    expect(response.status).toBe(409);
    expect(
      await env.DB.prepare(
        "SELECT mailbox_id FROM messages WHERE id='message'",
      ).first<{ mailbox_id: string }>(),
    ).toEqual({ mailbox_id: "mailbox" });
    expect(await env.DB.prepare("SELECT id FROM mailboxes").first()).toEqual({
      id: "mailbox",
    });
  });

  it("preserves a mailbox created in another tab during domain deletion", async () => {
    const headers = await authorize();
    await seedDomain();
    const response = await request(
      "/domains/domain",
      headers,
      beforeDelete("domains", seedMailbox),
    );
    expect(response.status).toBe(409);
    expect(
      await env.DB.prepare("SELECT domain_id FROM mailboxes").first(),
    ).toEqual({
      domain_id: "domain",
    });
    expect(await env.DB.prepare("SELECT id FROM domains").first()).toEqual({
      id: "domain",
    });
  });
});
