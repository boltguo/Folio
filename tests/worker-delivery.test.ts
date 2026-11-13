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
import type { MessageDetail } from "../src/shared/types";

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

async function setup() {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO admins(id,email,password_hash,created_at) VALUES('admin','admin@example.com','unused',1)",
    ),
    env.DB.prepare(
      "INSERT INTO sessions(id_hash,admin_id,expires_at,created_at) VALUES(?,'admin',?,1)",
    ).bind(
      await sessionDigest("delivery-session", env.SESSION_SECRET),
      now() + 3600,
    ),
    env.DB.prepare(
      "INSERT INTO domains(id,name,status,receiving_enabled,sending_enabled,created_at,updated_at) VALUES('domain','example.com','active',1,1,1,1)",
    ),
    env.DB.prepare(
      "INSERT INTO mailboxes(id,domain_id,local_part,email,created_at) VALUES('mailbox','domain','inbox','inbox@example.com',1)",
    ),
  ]);
  const headers = {
    Cookie: "folio_session=delivery-session",
    "Content-Type": "application/json",
    "Idempotency-Key": "delivery-test",
  };
  const provider = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, init) =>
      init?.method === "POST"
        ? Response.json({ id: "provider-delivery" })
        : Response.json({ message_id: "<delivery@example.com>" }),
    );
  async function send(
    to = ["a@example.net", "b@example.net"],
    cc: string[] = [],
    bcc: string[] = [],
  ) {
    const response = await request("/send", {
      method: "POST",
      headers,
      body: JSON.stringify({
        mailboxId: "mailbox",
        to,
        cc,
        bcc,
        subject: "Delivery test",
        text: "Hello",
      }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json<{ id: string }>()).id;
  }
  const detail = async (id: string) =>
    (await request(`/messages/${id}`, { headers })).json<MessageDetail>();
  return { headers, provider, send, detail };
}

async function webhook(
  id: string,
  type: string,
  to: string[] | undefined,
  seconds: number,
  extra = {},
) {
  const timestamp = String(now());
  const body = JSON.stringify({
    type,
    created_at: new Date(seconds * 1000).toISOString(),
    data: {
      email_id: "provider-delivery",
      ...(to === undefined ? {} : { to }),
      ...extra,
    },
  });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.RESEND_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  );
  const response = await request("/webhooks/resend", {
    method: "POST",
    headers: {
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${btoa(String.fromCharCode(...new Uint8Array(signed)))}`,
    },
    body,
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

describe("per-recipient delivery outcomes", () => {
  it("preserves one recipient's bounce when another recipient is delivered, including duplicate and out-of-order events", async () => {
    const { send, detail } = await setup();
    const id = await send();
    await webhook("bounce-a", "email.bounced", ["a@example.net"], 20, {
      bounce: { subType: "NoEmail", message: "Mailbox does not exist" },
    });
    await webhook("delivered-b", "email.delivered", ["b@example.net"], 30);
    let result = await detail(id);
    expect(result.status).toBe("partial_failed");
    expect(
      result.deliveries?.map((recipient) => [
        recipient.address,
        recipient.status,
      ]),
    ).toEqual([
      ["a@example.net", "bounced"],
      ["b@example.net", "delivered"],
    ]);
    expect(result.deliveries?.[0].error_message).toBe("Mailbox does not exist");
    const revision = result.delivery_revision;
    await webhook("delivered-b", "email.delivered", ["b@example.net"], 30);
    expect((await detail(id)).delivery_revision).toBe(revision);
    await webhook("late-delivered-a", "email.delivered", ["a@example.net"], 10);
    await webhook("late-sent-b", "email.sent", ["b@example.net"], 40);
    await webhook(
      "late-delayed-b",
      "email.delivery_delayed",
      ["b@example.net"],
      50,
    );
    result = await detail(id);
    expect(result.status).toBe("partial_failed");
    expect(result.deliveries?.map((recipient) => recipient.status)).toEqual([
      "bounced",
      "delivered",
    ]);
  });

  it("accepts declared To/Cc/Bcc recipients only and deduplicates addresses", async () => {
    const { send, detail } = await setup();
    const id = await send(
      ["a@example.net"],
      ["A@example.net", "cc@example.net"],
      ["hidden@example.net"],
    );
    await webhook("unrelated", "email.bounced", ["stranger@example.net"], 20);
    let result = await detail(id);
    expect(result.status).toBe("sent");
    expect(result.deliveries).toHaveLength(3);
    expect(result.delivery_revision).toBe(0);
    await webhook("cc-delivered", "email.delivered", ["CC@example.net"], 30);
    await webhook(
      "bcc-delivered",
      "email.delivered",
      ["hidden@example.net"],
      40,
    );
    result = await detail(id);
    expect(result.status).toBe("partial_delivered");
    expect(
      result.deliveries?.find((recipient) => recipient.recipient_type === "bcc")
        ?.status,
    ).toBe("delivered");
  });

  it("reconciles early outcomes once the provider id is saved", async () => {
    const { send, detail } = await setup();
    await webhook("early-delivered", "email.delivered", ["a@example.net"], 20);
    const id = await send();
    expect((await detail(id)).status).toBe("partial_delivered");
    await webhook("second-delivered", "email.delivered", ["b@example.net"], 30);
    expect((await detail(id)).status).toBe("delivered");
  });

  it("records failed/suppressed reasons and never resubmits an accepted email", async () => {
    const { send, detail, headers, provider } = await setup();
    const id = await send();
    await webhook("failed-a", "email.failed", ["a@example.net"], 20, {
      failed: { reason: "reached_daily_quota" },
    });
    await webhook("suppressed-b", "email.suppressed", ["b@example.net"], 30, {
      suppressed: {
        type: "OnAccountSuppressionList",
        message: "Recipient is suppressed",
      },
    });
    const result = await detail(id);
    expect(result.status).toBe("failed");
    expect(result.deliveries?.map((recipient) => recipient.error_code)).toEqual(
      ["reached_daily_quota", "OnAccountSuppressionList"],
    );
    expect(result.deliveries?.[1].error_message).toBe(
      "Recipient is suppressed",
    );
    await request(`/send/${id}/retry`, { method: "POST", headers });
    expect(
      provider.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
  });

  it("preserves complaints separately and ignores later progress events", async () => {
    const { send, detail } = await setup();
    const id = await send(["a@example.net"]);
    await webhook("complaint", "email.complained", ["a@example.net"], 20);
    await webhook("old-complaint", "email.complained", ["a@example.net"], 10);
    await webhook(
      "late-delay",
      "email.delivery_delayed",
      ["a@example.net"],
      30,
    );
    const result = await detail(id);
    expect(result.status).toBe("delivered");
    expect(result.deliveries?.[0].complained_at).toBe(20_000);
  });

  it("associates legacy recipient-less events only with a single recipient", async () => {
    const { send, detail } = await setup();
    const id = await send();
    await webhook("legacy-multi", "email.delivered", undefined, 20);
    expect((await detail(id)).status).toBe("sent");
    await env.DB.prepare(
      "UPDATE messages SET to_addresses='[\"a@example.net\"]' WHERE id=?",
    )
      .bind(id)
      .run();
    await env.DB.prepare(
      "DELETE FROM message_deliveries WHERE address='b@example.net'",
    ).run();
    await webhook("legacy-single", "email.delivered", undefined, 30);
    expect((await detail(id)).status).toBe("delivered");
  });

  it("backfills legacy recipients and their stored outcome history", async () => {
    await reset();
    const index = env.TEST_MIGRATIONS.findIndex((migration) =>
      migration.name.startsWith("0003"),
    );
    expect(index).toBeGreaterThan(0);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(0, index));
    await env.DB.prepare(
      `INSERT INTO messages(id,direction,from_address,to_addresses,cc_addresses,bcc_addresses,status,provider_message_id,received_at,created_at)
      VALUES('legacy','outbound','me@example.com','["a@example.net","b@example.net"]','["A@example.net"]','["hidden@example.net"]','delivered','legacy-provider',1,1)`,
    ).run();
    const events = [
      {
        id: "legacy-bounce",
        type: "email.bounced",
        to: ["a@example.net"],
        at: 20,
        bounce: { message: "No such mailbox" },
      },
      {
        id: "legacy-delivered",
        type: "email.delivered",
        to: ["b@example.net"],
        at: 30,
      },
      {
        id: "legacy-unrelated",
        type: "email.delivered",
        to: ["stranger@example.net"],
        at: 40,
      },
    ];
    for (const event of events)
      await env.DB.prepare(
        "INSERT INTO webhook_events(id,event_type,payload,provider_message_id,event_timestamp,processed_at,created_at) VALUES(?,?,?,'legacy-provider',?,1,1)",
      )
        .bind(
          event.id,
          event.type,
          JSON.stringify({
            type: event.type,
            data: { to: event.to, bounce: event.bounce },
          }),
          event.at * 1000,
        )
        .run();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(index));
    expect(
      (
        await env.DB.prepare(
          "SELECT status FROM messages WHERE id='legacy'",
        ).first<{ status: string }>()
      )?.status,
    ).toBe("partial_failed");
    const rows = await env.DB.prepare(
      "SELECT address,status,error_message FROM message_deliveries ORDER BY address",
    ).all();
    expect(rows.results).toEqual([
      {
        address: "a@example.net",
        status: "bounced",
        error_message: "No such mailbox",
      },
      { address: "b@example.net", status: "delivered", error_message: null },
      { address: "hidden@example.net", status: "sent", error_message: null },
    ]);
  });
});
