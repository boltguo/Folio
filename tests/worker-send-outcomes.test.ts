import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  createExecutionContext,
  reset,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/server/index";
import { now, sessionDigest } from "../src/server/lib";
import type { MessageDetail, SendFailureInfo } from "../src/shared/types";

interface SendResult extends SendFailureInfo {
  id?: string;
  messageId?: string;
  code?: string;
  status?: string;
}

async function request(path: string, init: RequestInit = {}) {
  const context = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://mail.example.com/api/v1${path}`, init),
    env,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

async function setup(...responses: (Response | Error)[]) {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO admins(id,email,password_hash,created_at) VALUES('admin','admin@example.com','unused',1)",
    ),
    env.DB.prepare(
      "INSERT INTO sessions(id_hash,admin_id,expires_at,created_at) VALUES(?,'admin',?,1)",
    ).bind(
      await sessionDigest("send-session", env.SESSION_SECRET),
      now() + 3600,
    ),
    env.DB.prepare(
      "INSERT INTO domains(id,name,status,receiving_enabled,sending_enabled,created_at,updated_at) VALUES('domain','example.com','active',1,1,1,1)",
    ),
    env.DB.prepare(
      "INSERT INTO mailboxes(id,domain_id,local_part,email,created_at) VALUES('mailbox','domain','inbox','inbox@example.com',1)",
    ),
  ]);
  const provider = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, init) => {
      if (init?.method !== "POST")
        return Response.json({ message_id: "<send@example.com>" });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      if (!response) throw new Error("Unexpected provider request");
      return response;
    });
  const headers = {
    Cookie: "folio_session=send-session",
    "Content-Type": "application/json",
  };
  const send = (key = "send-test", text = "Hello") =>
    request("/send", {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": key },
      body: JSON.stringify({
        mailboxId: "mailbox",
        to: ["a@example.net"],
        subject: "Send test",
        text,
      }),
    });
  const retry = (id: string) =>
    request(`/send/${id}/retry`, { method: "POST", headers });
  const detail = async (id: string) =>
    (await request(`/messages/${id}`, { headers })).json<MessageDetail>();
  const calls = () =>
    provider.mock.calls.filter(([, init]) => init?.method === "POST");
  return { send, retry, detail, calls };
}

const rejected = () =>
  Response.json(
    { name: "validation_error", message: "The from address is not verified" },
    { status: 422 },
  );

describe("safe sending outcomes", () => {
  it("unlocks a definite first rejection, retains its reason, and requires a new key for a corrected send", async () => {
    const { send, retry, detail, calls } = await setup(
      rejected(),
      Response.json({ id: "accepted-new" }),
    );
    const response = await send();
    expect(response.status).toBe(422);
    const result = await response.json<SendResult>();
    expect(result).toMatchObject({
      code: "SEND_REJECTED",
      submissionState: "not_accepted",
      retryable: false,
      canEdit: true,
      providerCode: "validation_error",
    });
    expect(await detail(result.messageId!)).toMatchObject({
      submission_state: "not_accepted",
      send_retryable: false,
      send_can_edit: true,
      send_error: "The from address is not verified",
    });
    expect((await retry(result.messageId!)).status).toBe(422);
    const changed = await send("send-test", "Corrected content");
    expect(changed.status).toBe(409);
    expect((await changed.json<SendResult>()).code).toBe("SEND_KEY_CONFLICT");
    expect(calls()).toHaveLength(1);
    expect((await send("corrected-send", "Corrected content")).status).toBe(
      200,
    );
    expect(calls()).toHaveLength(2);
    expect(new Headers(calls()[0][1]?.headers).get("Idempotency-Key")).not.toBe(
      new Headers(calls()[1][1]?.headers).get("Idempotency-Key"),
    );
  });

  it("honors Retry-After and retries a rate-limited request with its stored key and payload", async () => {
    const { send, retry, calls } = await setup(
      Response.json(
        { name: "rate_limit_exceeded", message: "Too many requests" },
        { status: 429, headers: { "Retry-After": "120" } },
      ),
      Response.json({ id: "accepted-retry" }),
    );
    const response = await send();
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("120");
    const result = await response.json<SendResult>();
    expect(result).toMatchObject({
      code: "SEND_RATE_LIMITED",
      submissionState: "not_accepted",
      retryable: true,
      canEdit: false,
      retryAfter: 120,
    });
    expect((await retry(result.messageId!)).status).toBe(429);
    expect(calls()).toHaveLength(1);
    await env.DB.prepare(
      "UPDATE send_logs SET retry_after=0 WHERE message_id=?",
    )
      .bind(result.messageId)
      .run();
    expect((await retry(result.messageId!)).status).toBe(200);
    expect(calls()).toHaveLength(2);
    expect(calls()[1][1]?.body).toBe(calls()[0][1]?.body);
    expect(new Headers(calls()[1][1]?.headers).get("Idempotency-Key")).toBe(
      new Headers(calls()[0][1]?.headers).get("Idempotency-Key"),
    );
  });

  it("keeps an earlier uncertain attempt locked even if a later attempt is explicitly rejected", async () => {
    const { send, retry, detail, calls } = await setup(
      new TypeError("Connection lost"),
      rejected(),
      Response.json({ id: "accepted-original" }),
    );
    const result = await (await send()).json<SendResult>();
    expect(result).toMatchObject({
      code: "SEND_UNCONFIRMED",
      submissionState: "uncertain",
      retryable: true,
      canEdit: false,
    });
    const second = await retry(result.messageId!);
    expect(second.status).toBe(502);
    expect(await second.json()).toMatchObject({
      code: "SEND_UNCONFIRMED",
      submissionState: "uncertain",
      retryable: true,
      canEdit: false,
    });
    expect(await detail(result.messageId!)).toMatchObject({
      submission_state: "uncertain",
      send_retryable: true,
      send_can_edit: false,
    });
    expect((await retry(result.messageId!)).status).toBe(200);
    expect(
      new Set(
        calls().map(([, init]) =>
          new Headers(init?.headers).get("Idempotency-Key"),
        ),
      ).size,
    ).toBe(1);
    expect(new Set(calls().map(([, init]) => init?.body)).size).toBe(1);
  });

  it.each([
    [
      "non-JSON upstream failure",
      () => new Response("Unavailable", { status: 503 }),
      "SEND_UNCONFIRMED",
      true,
    ],
    [
      "invalid successful response",
      () => Response.json({ id: 123 }),
      "SEND_UNCONFIRMED",
      true,
    ],
    [
      "idempotency conflict",
      () =>
        Response.json({ name: "invalid_idempotent_request" }, { status: 409 }),
      "SEND_IDEMPOTENCY_CONFLICT",
      false,
    ],
  ])("does not unlock %s", async (_label, response, code, retryable) => {
    const { send, retry, calls } = await setup(response());
    const result = await (await send()).json<SendResult>();
    expect(result).toMatchObject({
      code,
      submissionState: "uncertain",
      retryable,
      canEdit: false,
    });
    if (!retryable) {
      expect((await retry(result.messageId!)).status).toBe(409);
      expect(calls()).toHaveLength(1);
    }
  });

  it("does not clear uncertainty when sending is disabled after an ambiguous attempt", async () => {
    const { send, calls } = await setup(new TypeError("Connection lost"));
    const result = await (await send()).json<SendResult>();
    await env.DB.prepare(
      "UPDATE mailboxes SET enabled=0 WHERE id='mailbox'",
    ).run();
    const response = await send();
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "SENDER_DISABLED",
      messageId: result.messageId,
      submissionState: "uncertain",
      canEdit: false,
    });
    expect(calls()).toHaveLength(1);
  });

  it("does not unlock a still-retryable record while a submission lease is active", async () => {
    const { send, calls } = await setup(
      Response.json({ name: "rate_limit_exceeded" }, { status: 429 }),
    );
    const result = await (await send()).json<SendResult>();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE send_logs SET lease_until=? WHERE message_id=?",
      ).bind(now() + 120, result.messageId),
      env.DB.prepare("UPDATE mailboxes SET enabled=0 WHERE id='mailbox'"),
    ]);
    const response = await send();
    expect(await response.json()).toMatchObject({
      code: "SENDER_DISABLED",
      messageId: result.messageId,
      submissionState: "uncertain",
      canEdit: false,
    });
    expect(calls()).toHaveLength(1);
  });

  it("does not resubmit an accepted message whose asynchronous delivery failed", async () => {
    const { send, retry, detail, calls } = await setup(
      Response.json({ id: "accepted-final" }),
    );
    const result = await (await send()).json<SendResult>();
    await env.DB.prepare("UPDATE messages SET status='suppressed' WHERE id=?")
      .bind(result.id)
      .run();
    const response = await retry(result.id!);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "DELIVERY_FINAL",
      submissionState: "accepted",
      retryable: false,
      canEdit: false,
    });
    expect(await detail(result.id!)).toMatchObject({
      submission_state: "accepted",
      send_retryable: false,
      send_can_edit: false,
    });
    expect(calls()).toHaveLength(1);
  });

  it("backfills legacy failed and attempted sends conservatively while retaining confirmed acceptance", async () => {
    await reset();
    const index = env.TEST_MIGRATIONS.findIndex((migration) =>
      migration.name.startsWith("0004"),
    );
    expect(index).toBeGreaterThan(0);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(0, index));
    const rows = [
      { id: "failed", status: "failed", attempted: null, provider: null },
      { id: "unknown", status: "unknown", attempted: 1, provider: null },
      { id: "attempted", status: "pending", attempted: 1, provider: null },
      { id: "unattempted", status: "pending", attempted: null, provider: null },
      {
        id: "accepted",
        status: "failed",
        attempted: 1,
        provider: "provider-known",
      },
    ];
    for (const row of rows) {
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO messages(id,direction,from_address,to_addresses,status,provider_message_id,received_at,created_at) VALUES(?,'outbound','me@example.com','[\"a@example.net\"]',?,?,1,1)",
        ).bind(row.id, row.status, row.provider),
        env.DB.prepare(
          "INSERT INTO send_logs(id,message_id,status,idempotency_key,payload_hash,payload_key,attempted_at,created_at) VALUES(?,?,?,?,?,?,?,1)",
        ).bind(
          row.id,
          row.id,
          row.status,
          row.id,
          "hash",
          "payload",
          row.attempted,
        ),
      ]);
    }
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(index));
    const migrated = (
      await env.DB.prepare(
        "SELECT id,submission_state,retryable,can_edit FROM send_logs ORDER BY id",
      ).all()
    ).results;
    expect(migrated).toEqual([
      {
        id: "accepted",
        submission_state: "accepted",
        retryable: 0,
        can_edit: 0,
      },
      {
        id: "attempted",
        submission_state: "uncertain",
        retryable: 1,
        can_edit: 0,
      },
      {
        id: "failed",
        submission_state: "uncertain",
        retryable: 1,
        can_edit: 0,
      },
      {
        id: "unattempted",
        submission_state: "not_accepted",
        retryable: 1,
        can_edit: 0,
      },
      {
        id: "unknown",
        submission_state: "uncertain",
        retryable: 1,
        can_edit: 0,
      },
    ]);
  });
});
