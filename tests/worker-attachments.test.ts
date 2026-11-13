import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { expect, it, vi } from "vitest";
import worker from "../src/server/index";
import { now, sessionDigest } from "../src/server/lib";
import { MAX_ATTACHMENT_BYTES, sendInput } from "../src/server/validation";

const draft = {
  mailboxId: "mailbox",
  to: ["recipient@example.net"],
  subject: "Attachment test",
  text: "Please find the attached file.",
};
const attachment = (size: number) => ({
  filename: "document.bin",
  content: btoa("A".repeat(size)),
});

it("accepts a full 10 MiB attachment in workerd without regexp stack exhaustion", () => {
  const result = sendInput.safeParse({
    ...draft,
    attachments: [attachment(MAX_ATTACHMENT_BYTES)],
  });
  expect(result.success).toBe(true);
});

it("rejects decoded and combined attachments over the size limit", () => {
  for (const attachments of [
    [attachment(MAX_ATTACHMENT_BYTES + 1)],
    [
      attachment(MAX_ATTACHMENT_BYTES / 2),
      attachment(MAX_ATTACHMENT_BYTES / 2 + 1),
    ],
  ]) {
    expect(sendInput.safeParse({ ...draft, attachments }).success).toBe(false);
  }
});

it.each([
  "A",
  "AAAAA",
  "A===",
  "====",
  "AA=A",
  "=AAA",
  "AA-_",
  "AA A",
  "AA\nA",
  "AAAA=",
  "AA\u00e9A",
])("rejects malformed base64 %j", (content) => {
  expect(
    sendInput.safeParse({
      ...draft,
      attachments: [{ filename: "invalid.bin", content }],
    }).success,
  ).toBe(false);
});

it("sends and stores a valid 5 MB attachment through the authenticated worker route", async () => {
  await env.DB.prepare(
    "INSERT INTO admins(id,email,password_hash,created_at) VALUES('admin','admin@example.com','unused',1)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO sessions(id_hash,admin_id,expires_at,created_at) VALUES(?,'admin',?,1)",
  )
    .bind(
      await sessionDigest("attachment-session", env.SESSION_SECRET),
      now() + 3600,
    )
    .run();
  await env.DB.prepare(
    "INSERT INTO domains(id,name,status,receiving_enabled,sending_enabled,created_at,updated_at) VALUES('domain','example.com','active',1,1,1,1)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO mailboxes(id,domain_id,local_part,email,created_at) VALUES('mailbox','domain','inbox','inbox@example.com',1)",
  ).run();
  const file = attachment(5_000_000);
  const provider = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, init) => {
      if (init?.method === "POST") {
        const payload = JSON.parse(String(init.body));
        expect(payload.attachments[0].content).toBe(file.content);
        return Response.json({ id: "provider-large-attachment" });
      }
      return Response.json({ message_id: "<large@example.net>" });
    });
  const context = createExecutionContext();
  const response = await worker.fetch(
    new Request("https://mail.example.com/api/v1/send", {
      method: "POST",
      headers: {
        Cookie: "folio_session=attachment-session",
        "Content-Type": "application/json",
        "Idempotency-Key": "large-attachment",
      },
      body: JSON.stringify({ ...draft, attachments: [file] }),
    }),
    env,
    context,
  );
  await waitOnExecutionContext(context);
  expect(response.status, await response.clone().text()).toBe(200);
  const sent = await response.json<{ id: string }>();
  const stored = await env.DB.prepare(
    "SELECT size,r2_key FROM attachments WHERE message_id=?",
  )
    .bind(sent.id)
    .first<{ size: number; r2_key: string }>();
  expect(stored?.size).toBe(5_000_000);
  expect((await env.MAIL_STORAGE.head(stored!.r2_key))?.size).toBe(5_000_000);
  expect(
    provider.mock.calls.filter(([, init]) => init?.method === "POST"),
  ).toHaveLength(1);
});
