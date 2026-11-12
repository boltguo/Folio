import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PostalMime from "postal-mime";
import worker from "../src/server/index";
import {
  hashPassword,
  now,
  sessionDigest,
  verifyPassword,
} from "../src/server/lib";
import { findMailbox, storeInbound } from "../src/server/services/inbound";
import type { MessageDetail, MessagePage } from "../src/shared/types";

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
async function login() {
  const response = await request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: env.ADMIN_EMAIL,
      password: env.ADMIN_PASSWORD,
    }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.headers.get("Set-Cookie")!.split(";")[0];
}
async function authorized() {
  await env.DB.prepare(
    "INSERT INTO admins(id,email,password_hash,created_at) VALUES('admin','admin@example.com','unused',1)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO sessions(id_hash,admin_id,expires_at,created_at) VALUES(?,'admin',?,1)",
  )
    .bind(await sessionDigest("test-session", env.SESSION_SECRET), now() + 3600)
    .run();
  return {
    Cookie: "folio_session=test-session",
    "Content-Type": "application/json",
  };
}
async function seedMailbox() {
  await env.DB.prepare(
    "INSERT INTO domains(id,name,status,receiving_enabled,sending_enabled,created_at,updated_at) VALUES('domain','example.com','active',1,1,1,1)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO mailboxes(id,domain_id,local_part,email,created_at) VALUES('mailbox','domain','inbox','inbox@example.com',1)",
  ).run();
}
const mail = (
  messageId = "<message@example.com>",
  subject = "Hello",
  body = "Hello world",
) =>
  new TextEncoder().encode(
    `From: Sender <sender@example.net>\r\nTo: inbox@example.com\r\n${messageId ? `Message-ID: ${messageId}\r\n` : ""}Subject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`,
  ).buffer;
const compose = {
  mailboxId: "mailbox",
  to: ["recipient@example.net"],
  subject: "Test send",
  text: "Test body",
};
const mockResend = () =>
  vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_input, init) =>
      init?.method === "POST"
        ? Response.json({ id: "provider-1" })
        : Response.json({ message_id: "<sent@example.net>" }),
    );
async function webhook(
  eventId: string,
  type: string,
  createdAt: string,
  timestamp = String(now()),
) {
  const body = JSON.stringify({
    type,
    created_at: createdAt,
    data: { email_id: "provider-1" },
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
    new TextEncoder().encode(`${eventId}.${timestamp}.${body}`),
  );
  const signature = btoa(String.fromCharCode(...new Uint8Array(signed)));
  return request("/webhooks/resend", {
    method: "POST",
    headers: {
      "svix-id": eventId,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signature}`,
    },
    body,
  });
}

describe("authentication and configuration", () => {
  beforeEach(() => {
    // Local workerd may accept more iterations than deployed Workers.
    const deriveBits = crypto.subtle.deriveBits.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "deriveBits").mockImplementation(
      (algorithm, key, length) => {
        if (
          typeof algorithm === "object" &&
          algorithm.name === "PBKDF2" &&
          "iterations" in algorithm &&
          Number(algorithm.iterations) > 100000
        ) {
          throw new DOMException(
            "PBKDF2 iteration counts above 100000 are not supported",
            "NotSupportedError",
          );
        }
        return deriveBits(algorithm, key, length);
      },
    );
  });
  it("returns stable error codes while keeping the login gate", async () => {
    const anonymous = await request("/messages");
    expect(anonymous.status).toBe(401);
    expect((await anonymous.json<{ code: string }>()).code).toBe(
      "AUTH_REQUIRED",
    );
    const invalid = await request("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: "unknown@example.com",
        password: "invalid",
      }),
    });
    expect((await invalid.json<{ code: string }>()).code).toBe(
      "INVALID_CREDENTIALS",
    );
    const malformed = await request("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: 42 }),
    });
    const body = await malformed.json<{ code: string; details: string }>();
    expect(body.code).toBe("INVALID_INPUT");
    expect(body.details).toContain("email");
  });
  it("hashes passwords and bootstraps/login/logout within the production PBKDF2 limit", async () => {
    const hash = await hashPassword("password-123456");
    expect(await verifyPassword("password-123456", hash)).toBe(true);
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
    const cookie = await login();
    expect(
      (await request("/auth/me", { headers: { Cookie: cookie } })).status,
    ).toBe(200);
    expect(
      (
        await request("/auth/logout", {
          method: "POST",
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(200);
    expect(
      (await request("/auth/me", { headers: { Cookie: cookie } })).status,
    ).toBe(401);
  });
  it("checks origin even on login and returns JSON validation errors", async () => {
    expect(
      (
        await request("/auth/login", {
          method: "POST",
          headers: { Origin: "https://other.example" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect(
      (await request("/auth/login", { method: "POST", body: "{broken" }))
        .status,
    ).toBe(400);
    expect(
      (
        await request("/auth/login", {
          method: "POST",
          body: '{"email":42,"password":[]}',
        })
      ).status,
    ).toBe(400);
  });
  it("limits repeated login attempts in D1", async () => {
    for (let i = 0; i < 10; i++)
      expect(
        (
          await request("/auth/login", {
            method: "POST",
            body: JSON.stringify({
              email: "nobody@example.com",
              password: "incorrect",
            }),
          })
        ).status,
      ).toBe(401);
    const response = await request("/auth/login", {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
  it("revokes every session after password change", async () => {
    const first = await login(),
      second = await login();
    const response = await request("/auth/change-password", {
      method: "POST",
      headers: { Cookie: first },
      body: JSON.stringify({
        currentPassword: env.ADMIN_PASSWORD,
        newPassword: "new-password-123456",
      }),
    });
    expect(response.status).toBe(200);
    for (const cookie of [first, second])
      expect(
        (await request("/auth/me", { headers: { Cookie: cookie } })).status,
      ).toBe(401);
    for (const [password, status] of [
      [env.ADMIN_PASSWORD, 401],
      ["new-password-123456", 200],
    ] as const) {
      const loginResponse = await request("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: env.ADMIN_EMAIL, password }),
      });
      expect(loginResponse.status, await loginResponse.clone().text()).toBe(
        status,
      );
    }
  });
});

describe("receiving mail", () => {
  it("rejects unknown and oversized recipients before saving", async () => {
    await seedMailbox();
    for (const [to, rawSize] of [
      ["unknown@example.com", 1],
      ["inbox@example.com", 30 * 1024 * 1024],
    ] as const) {
      const reject = vi.fn();
      await worker.email(
        {
          to,
          from: "sender@example.net",
          raw: new Response("test").body!,
          rawSize,
          headers: new Headers(),
          setReject: reject,
          forward: vi.fn(),
          reply: vi.fn(),
        },
        env,
      );
      expect(reject).toHaveBeenCalledOnce();
    }
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) n FROM messages").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(0);
  });
  it("deduplicates no-ID messages and preserves the original raw mail for repeated Message-IDs", async () => {
    await seedMailbox();
    const mailbox = (await findMailbox(env, "inbox@example.com"))!;
    const first = await storeInbound(
      env,
      mailbox,
      mail(),
      "sender@example.net",
    );
    const duplicate = await storeInbound(
      env,
      mailbox,
      mail("<message@example.com>", "Different", "Changed"),
      "sender@example.net",
    );
    expect(duplicate.id).toBe(first.id);
    expect(await (await env.MAIL_STORAGE.get(first.rawKey))!.text()).toContain(
      "Hello world",
    );
    const noId = await storeInbound(
      env,
      mailbox,
      mail("", "No ID"),
      "sender@example.net",
    );
    const noIdAgain = await storeInbound(
      env,
      mailbox,
      mail("", "No ID"),
      "sender@example.net",
    );
    expect(noIdAgain.id).toBe(noId.id);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) n FROM messages").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(2);
  });
  it("records raw object keys on parse failure and can replay saved mail", async () => {
    const headers = await authorized();
    await seedMailbox();
    const parser = vi
      .spyOn(PostalMime, "parse")
      .mockRejectedValueOnce(new Error("Temporary parser failure"));
    await expect(
      storeInbound(
        env,
        (await findMailbox(env, "inbox@example.com"))!,
        mail(),
        "sender@example.net",
      ),
    ).rejects.toThrow("Temporary parser failure");
    const failure = await env.DB.prepare(
      "SELECT id,raw_object_key FROM inbound_failures",
    ).first<{ id: string; raw_object_key: string }>();
    expect(await env.MAIL_STORAGE.get(failure!.raw_object_key)).not.toBeNull();
    parser.mockRestore();
    const response = await request(`/settings/failures/${failure!.id}/replay`, {
      method: "POST",
      headers,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(
      (
        await env.DB.prepare("SELECT resolved_at FROM inbound_failures").first<{
          resolved_at: number;
        }>()
      )?.resolved_at,
    ).toBeGreaterThan(0);
  });
  it("saves attachments and keeps receipt successful when forwarding fails", async () => {
    await seedMailbox();
    await env.DB.prepare(
      "UPDATE mailboxes SET forward_enabled=1,forward_to='target@example.net'",
    ).run();
    const raw =
      "From: sender@example.net\r\nTo: inbox@example.com\r\nMessage-ID: <attachment@example.net>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nBody\r\n--x\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename=test.txt\r\n\r\nAttachment content\r\n--x--";
    await worker.email(
      {
        to: "inbox@example.com",
        from: "sender@example.net",
        raw: new Response(raw).body!,
        rawSize: raw.length,
        headers: new Headers(),
        setReject: vi.fn(),
        forward: vi
          .fn()
          .mockRejectedValue(new Error("destination not verified")),
        reply: vi.fn(),
      },
      env,
    );
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) n FROM attachments").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(1);
    expect(
      (
        await env.DB.prepare("SELECT reason FROM inbound_failures").first<{
          reason: string;
        }>()
      )?.reason,
    ).toContain("Forward failed");
  });
});

describe("sending and webhook reconciliation", () => {
  it("persists attachments/HTML and returns the same send for an identical key", async () => {
    const headers = { ...(await authorized()), "Idempotency-Key": "same-send" };
    await seedMailbox();
    const provider = mockResend();
    const body = JSON.stringify({
      ...compose,
      html: "<p>Hello</p>",
      attachments: [
        {
          filename: "note.txt",
          content: btoa("attachment"),
          contentType: "text/plain",
        },
      ],
    });
    const first = await request("/send", { method: "POST", headers, body });
    expect(first.status, await first.clone().text()).toBe(200);
    const sent = await first.json<{ id: string }>();
    const duplicate = await request("/send", { method: "POST", headers, body });
    expect((await duplicate.json<{ id: string }>()).id).toBe(sent.id);
    expect(
      provider.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    const detail = await (
      await request(`/messages/${sent.id}`, { headers })
    ).json<MessageDetail>();
    expect(detail.body_html).toBe("<p>Hello</p>");
    expect(detail.attachments).toHaveLength(1);
    const attachment = await request(
      `/messages/attachments/${detail.attachments[0].id}`,
      { headers },
    );
    expect(await attachment.text()).toBe("attachment");
    expect(
      (
        await request("/send", {
          method: "POST",
          headers,
          body: JSON.stringify({ ...compose, text: "changed" }),
        })
      ).status,
    ).toBe(409);
  });
  it("retries uncertain sends with the immutable payload and original provider key", async () => {
    const headers = {
      ...(await authorized()),
      "Idempotency-Key": "uncertain-send",
    };
    await seedMailbox();
    const provider = mockResend().mockRejectedValueOnce(
      new Error("Network timeout"),
    );
    const response = await request("/send", {
      method: "POST",
      headers,
      body: JSON.stringify(compose),
    });
    expect(response.status).toBe(502);
    const failed = await response.json<{ messageId: string; status: string }>();
    expect(failed.status).toBe("unknown");
    expect(
      (
        await request(`/send/${failed.messageId}/retry`, {
          method: "POST",
          headers,
        })
      ).status,
    ).toBe(200);
    const sends = provider.mock.calls.filter(
      ([, init]) => init?.method === "POST",
    );
    expect(sends[0][1]?.body).toBe(sends[1][1]?.body);
    expect(sends[0][1]?.headers).toEqual(sends[1][1]?.headers);
  });
  it("blocks retries beyond the provider idempotency window", async () => {
    const headers = {
      ...(await authorized()),
      "Idempotency-Key": "expired-send",
    };
    await seedMailbox();
    const provider = mockResend().mockRejectedValueOnce(new Error("timeout"));
    const failed = await (
      await request("/send", {
        method: "POST",
        headers,
        body: JSON.stringify(compose),
      })
    ).json<{ messageId: string }>();
    await env.DB.prepare("UPDATE send_logs SET created_at=?")
      .bind(now() - 23 * 3600)
      .run();
    expect(
      (
        await request(`/send/${failed.messageId}/retry`, {
          method: "POST",
          headers,
        })
      ).status,
    ).toBe(409);
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it("does not mark an accepted email failed when D1 confirmation fails", async () => {
    const headers = {
      ...(await authorized()),
      "Idempotency-Key": "accepted-send",
    };
    await seedMailbox();
    await env.DB.exec(
      "CREATE TRIGGER fail_sent BEFORE UPDATE ON messages WHEN NEW.status='sent' BEGIN SELECT RAISE(ABORT, 'test persistence failure'); END;",
    );
    const provider = mockResend();
    const response = await request("/send", {
      method: "POST",
      headers,
      body: JSON.stringify(compose),
    });
    expect(response.status).toBe(502);
    const row = await env.DB.prepare("SELECT id,status FROM messages").first<{
      id: string;
      status: string;
    }>();
    expect(row?.status).toBe("pending");
    await env.DB.exec("DROP TRIGGER fail_sent;");
    await env.DB.prepare("UPDATE send_logs SET lease_until=0").run();
    expect(
      (await request(`/send/${row!.id}/retry`, { method: "POST", headers }))
        .status,
    ).toBe(200);
    expect(
      provider.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(2);
  });
  it("keeps concurrent submissions to one record and one provider call", async () => {
    const headers = {
      ...(await authorized()),
      "Idempotency-Key": "concurrent-send",
    };
    await seedMailbox();
    const provider = mockResend();
    const responses = await Promise.all(
      Array.from({ length: 2 }, () =>
        request("/send", {
          method: "POST",
          headers,
          body: JSON.stringify(compose),
        }),
      ),
    );
    expect(responses.some((response) => response.status === 200)).toBe(true);
    expect(
      responses.every((response) => [200, 409].includes(response.status)),
    ).toBe(true);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) n FROM messages").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(1);
    expect(
      provider.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
  });
  it("reconciles early events and never regresses delivery on late sent/delayed events", async () => {
    const headers = {
      ...(await authorized()),
      "Idempotency-Key": "webhook-send",
    };
    await seedMailbox();
    mockResend();
    expect(
      (
        await webhook(
          "early-delivered",
          "email.delivered",
          "2026-11-12T10:00:00Z",
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await env.DB.prepare("SELECT processed_at FROM webhook_events").first<{
          processed_at: number | null;
        }>()
      )?.processed_at,
    ).toBeNull();
    const response = await request("/send", {
      method: "POST",
      headers,
      body: JSON.stringify(compose),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await response.json<{ status: string }>()).status).toBe(
      "delivered",
    );
    for (const type of ["email.sent", "email.delivery_delayed"])
      expect((await webhook(type, type, "2026-11-12T10:00:01Z")).status).toBe(
        200,
      );
    expect(
      (
        await env.DB.prepare("SELECT status FROM messages").first<{
          status: string;
        }>()
      )?.status,
    ).toBe("delivered");
    expect(
      (
        await webhook(
          "early-delivered",
          "email.delivered",
          "2026-11-12T10:00:00Z",
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) n FROM webhook_events").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(3);
  });
  it("rejects invalid signatures and nonnumeric webhook timestamps", async () => {
    expect(
      (
        await request("/webhooks/resend", {
          method: "POST",
          headers: {
            "svix-id": "bad",
            "svix-timestamp": String(now()),
            "svix-signature": "v1,AAAA",
          },
          body: "{}",
        })
      ).status,
    ).toBe(401);
    expect(
      (await webhook("bad-time", "email.sent", "2026-11-12T10:00:00Z", "NaN"))
        .status,
    ).toBe(400);
  });
});

describe("mailbox API", () => {
  it("validates total recipients and malformed attachments without calling Resend", async () => {
    const headers = {
      ...(await authorized()),
      "Idempotency-Key": "invalid-send",
    };
    await seedMailbox();
    const provider = mockResend();
    for (const body of [
      {
        ...compose,
        cc: Array.from({ length: 50 }, (_, i) => `recipient${i}@example.net`),
      },
      {
        ...compose,
        attachments: [{ filename: "bad.txt", content: "not base64!" }],
      },
    ]) {
      expect(
        (
          await request("/send", {
            method: "POST",
            headers,
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(400);
    }
    expect(provider).not.toHaveBeenCalled();
  });
  it("rolls back the message if atomic send-log creation fails", async () => {
    const headers = {
      ...(await authorized()),
      "Idempotency-Key": "atomic-send",
    };
    await seedMailbox();
    const provider = mockResend();
    await env.DB.exec(
      "CREATE TRIGGER fail_log BEFORE INSERT ON send_logs BEGIN SELECT RAISE(ABORT, 'test log failure'); END;",
    );
    expect(
      (
        await request("/send", {
          method: "POST",
          headers,
          body: JSON.stringify(compose),
        })
      ).status,
    ).toBe(500);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) n FROM messages").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(0);
    expect(provider).not.toHaveBeenCalled();
  });
  it("paginates past 50 messages with deterministic ordering and allows restoration", async () => {
    const headers = await authorized();
    await seedMailbox();
    await env.DB.batch(
      Array.from({ length: 51 }, (_, i) =>
        env.DB.prepare(
          "INSERT INTO messages(id,mailbox_id,direction,from_address,received_at,created_at) VALUES(?,'mailbox','inbound','sender@example.net',1,1)",
        ).bind(String(i).padStart(2, "0")),
      ),
    );
    const first = await (
      await request("/messages", { headers })
    ).json<MessagePage>();
    const second = await (
      await request("/messages?offset=50", { headers })
    ).json<MessagePage>();
    expect(first.items).toHaveLength(50);
    expect(first.total).toBe(51);
    expect(second.items).toHaveLength(1);
    expect(first.items.some((m) => m.id === second.items[0].id)).toBe(false);
    await request("/messages/00", {
      method: "PATCH",
      headers,
      body: '{"isDeleted":true}',
    });
    expect(
      (
        await (
          await request("/messages?folder=trash", { headers })
        ).json<MessagePage>()
      ).total,
    ).toBe(1);
    await request("/messages/00", {
      method: "PATCH",
      headers,
      body: '{"isDeleted":false}',
    });
    expect(
      (await (await request("/messages", { headers })).json<MessagePage>())
        .total,
    ).toBe(51);
    expect((await request("/messages?limit=1.5", { headers })).status).toBe(
      400,
    );
    expect(
      (
        await request("/messages/missing", {
          method: "PATCH",
          headers,
          body: '{"isRead":true}',
        })
      ).status,
    ).toBe(404);
  });
  it("derives domain status and clears disabled forwarding destinations", async () => {
    const headers = await authorized();
    await seedMailbox();
    await request("/domains/domain", {
      method: "PATCH",
      headers,
      body: '{"sending_enabled":false}',
    });
    expect(
      (
        await env.DB.prepare("SELECT status FROM domains").first<{
          status: string;
        }>()
      )?.status,
    ).toBe("receiving");
    expect(
      (
        await request("/mailboxes/mailbox", {
          method: "PATCH",
          headers,
          body: '{"forwardEnabled":true}',
        })
      ).status,
    ).toBe(400);
    await request("/mailboxes/mailbox", {
      method: "PATCH",
      headers,
      body: '{"forwardEnabled":true,"forwardTo":"target@example.net"}',
    });
    await request("/mailboxes/mailbox", {
      method: "PATCH",
      headers,
      body: '{"forwardEnabled":false}',
    });
    expect(
      (
        await env.DB.prepare("SELECT forward_to FROM mailboxes").first<{
          forward_to: string | null;
        }>()
      )?.forward_to,
    ).toBeNull();
  });
});
