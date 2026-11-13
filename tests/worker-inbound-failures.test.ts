import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import worker from "../src/server/index";
import { findMailbox, storeInbound } from "../src/server/services/inbound";
import {
  mailboxAuthorization,
  mailboxRequest,
  seedMailbox,
} from "./mailbox-fixtures";

const raw = () =>
  new TextEncoder().encode(
    "From: sender@example.net\r\nTo: inbox@example.com\r\nSubject: Recovery\r\nContent-Type: text/plain\r\n\r\nSaved original",
  ).buffer;

it("preserves the original when the deduplication lookup fails and supports manual replay", async () => {
  const headers = await mailboxAuthorization();
  await seedMailbox();
  const mailbox = (await findMailbox(env, "inbox@example.com"))!;
  const prepare = env.DB.prepare.bind(env.DB);
  const database = vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
    if (
      sql.startsWith(
        "SELECT id FROM messages WHERE mailbox_id=? AND raw_object_key=?",
      )
    )
      throw new Error("Deduplication lookup unavailable");
    return prepare(sql);
  });
  await expect(
    storeInbound(env, mailbox, raw(), "sender@example.net"),
  ).rejects.toThrow("Deduplication lookup unavailable");
  database.mockRestore();
  const failure = await env.DB.prepare(
    "SELECT id,raw_object_key FROM inbound_failures",
  ).first<{ id: string; raw_object_key: string }>();
  expect(
    await (await env.MAIL_STORAGE.get(failure!.raw_object_key))!.text(),
  ).toContain("Saved original");
  const response = await mailboxRequest(
    `/settings/failures/${failure!.id}/replay`,
    { method: "POST", headers },
  );
  expect(response.status).toBe(200);
  expect(
    await env.DB.prepare("SELECT COUNT(*) FROM messages").first("COUNT(*)"),
  ).toBe(1);
  expect(
    await env.DB.prepare("SELECT resolved_at FROM inbound_failures WHERE id=?")
      .bind(failure!.id)
      .first("resolved_at"),
  ).not.toBeNull();
});

it("does not offer a nonexistent raw object for replay after an R2 write failure", async () => {
  const headers = await mailboxAuthorization();
  await seedMailbox();
  const mailbox = (await findMailbox(env, "inbox@example.com"))!;
  vi.spyOn(env.MAIL_STORAGE, "put").mockRejectedValueOnce(
    new Error("R2 unavailable"),
  );
  await expect(
    storeInbound(env, mailbox, raw(), "sender@example.net"),
  ).rejects.toThrow("R2 unavailable");
  const failure = await env.DB.prepare(
    "SELECT id,raw_object_key FROM inbound_failures",
  ).first<{ id: string; raw_object_key: string | null }>();
  expect(failure!.raw_object_key).toBeNull();
  expect(
    await env.DB.prepare("SELECT COUNT(*) FROM messages").first("COUNT(*)"),
  ).toBe(0);
  const response = await mailboxRequest(
    `/settings/failures/${failure!.id}/replay`,
    { method: "POST", headers },
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "RAW_UNAVAILABLE" });
});

it("retains raw mail and logs its key even when D1 cannot record the failure", async () => {
  await seedMailbox();
  const mailbox = (await findMailbox(env, "inbox@example.com"))!;
  vi.spyOn(env.DB, "prepare").mockImplementation(() => {
    throw new Error("D1 unavailable");
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(
    storeInbound(env, mailbox, raw(), "sender@example.net"),
  ).rejects.toThrow("D1 unavailable");
  const objects = await env.MAIL_STORAGE.list({
    prefix: `mail/${mailbox.id}/`,
  });
  expect(objects.objects).toHaveLength(1);
  const key = objects.objects[0].key;
  expect(key).toMatch(/\/raw\.eml$/);
  expect(log).toHaveBeenCalledWith(
    "inbound_failure",
    expect.objectContaining({ rawKey: key, recipient: mailbox.email }),
  );
});

it("logs mailbox lookup failures and propagates them instead of accepting or rejecting the mail silently", async () => {
  vi.spyOn(env.DB, "prepare").mockImplementation(() => {
    throw new Error("D1 unavailable");
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const reject = vi.fn();
  await expect(
    worker.email(
      {
        to: "inbox@example.com",
        from: "sender@example.net",
        rawSize: raw().byteLength,
        raw: new Response(raw()).body!,
        headers: new Headers(),
        setReject: reject,
        forward: vi.fn(),
        reply: vi.fn(),
      },
      env,
    ),
  ).rejects.toThrow("D1 unavailable");
  expect(reject).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(
    "inbound_failure",
    expect.objectContaining({
      recipient: "inbox@example.com",
      rawKey: null,
      reason: "Mailbox lookup failed: Error: D1 unavailable",
    }),
  );
});
