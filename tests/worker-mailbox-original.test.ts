import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  mailboxAuthorization,
  mailboxRequest,
  seedMailbox,
} from "./mailbox-fixtures";
import type { MessageDetail } from "../src/shared/types";

const original = new TextEncoder().encode(
  "From: Sender <sender@example.net>\r\nTo: inbox@example.com\r\nMessage-ID: <original@example.net>\r\nAuthentication-Results: example.com; dkim=pass\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n原始邮件内容\r\n",
);
let headers: HeadersInit;
beforeEach(async () => {
  headers = await mailboxAuthorization();
  await seedMailbox();
  await env.MAIL_STORAGE.put("mail/original.eml", original);
  await env.DB.prepare(
    "INSERT INTO messages(id,mailbox_id,direction,from_address,subject,raw_object_key,received_at,created_at) VALUES('original','mailbox','inbound','sender@example.net',?,'mail/original.eml',1,1)",
  )
    .bind("../私密\\O'Reilly\r\nmail")
    .run();
});

describe("original incoming mail download", () => {
  it("requires authentication before reading an original email", async () => {
    expect((await mailboxRequest("/messages/original/raw")).status).toBe(401);
  });

  it("downloads the unchanged source and headers with safe response headers", async () => {
    const response = await mailboxRequest("/messages/original/raw", {
      headers,
    });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(original);
    expect(response.headers.get("Content-Type")).toBe("message/rfc822");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const disposition = response.headers.get("Content-Disposition")!;
    expect(disposition).toMatch(/^attachment; filename\*=UTF-8''/);
    expect(disposition).toContain("%27");
    const filename = decodeURIComponent(disposition.split("UTF-8''")[1]);
    expect(filename).not.toMatch(/[\\/\r\n\0]/);
    expect(filename.endsWith(".eml")).toBe(true);
    const detail = await (
      await mailboxRequest("/messages/original", { headers })
    ).json<MessageDetail>();
    expect(detail.has_raw).toBe(true);
  });

  it("does not manufacture an original for outgoing messages", async () => {
    await env.DB.prepare(
      "INSERT INTO messages(id,mailbox_id,direction,from_address,received_at,created_at) VALUES('sent','mailbox','outbound','inbox@example.com',1,1)",
    ).run();
    const response = await mailboxRequest("/messages/sent/raw", { headers });
    expect(response.status).toBe(404);
    expect((await response.json<{ code: string }>()).code).toBe(
      "RAW_UNAVAILABLE",
    );
    const detail = await (
      await mailboxRequest("/messages/sent", { headers })
    ).json<MessageDetail>();
    expect(detail.has_raw).toBe(false);
  });

  it("reports absent source objects and missing message IDs", async () => {
    await env.MAIL_STORAGE.delete("mail/original.eml");
    const response = await mailboxRequest("/messages/original/raw", {
      headers,
    });
    expect(response.status).toBe(404);
    expect((await response.json<{ code: string }>()).code).toBe("RAW_MISSING");
    expect(
      (await mailboxRequest("/messages/missing/raw", { headers })).status,
    ).toBe(404);
  });
});
