import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  mailboxAuthorization,
  mailboxRequest,
  seedMailbox,
} from "./mailbox-fixtures";
import type { MessageDetail } from "../src/shared/types";
import { safeFilename } from "../src/server/lib";
import { findMailbox, storeInbound } from "../src/server/services/inbound";

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

  it("downloads an original with emoji across the filename length boundary", async () => {
    await env.DB.prepare("UPDATE messages SET subject=? WHERE id='original'")
      .bind("a" + "😀".repeat(90))
      .run();
    const response = await mailboxRequest("/messages/original/raw", {
      headers,
    });
    expect(response.status).toBe(200);
    const filename = decodeURIComponent(
      response.headers.get("Content-Disposition")!.split("UTF-8''")[1],
    );
    expect(filename).toBe("a" + "😀".repeat(89) + ".eml");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(original);
  });

  it("preserves a valid Unicode filename through inbound storage and attachment download", async () => {
    const filename = "a" + "😀".repeat(90);
    const raw = new TextEncoder().encode(
      `From: sender@example.net\r\nTo: inbox@example.com\r\nMessage-ID: <emoji-attachment@example.net>\r\nSubject: Attachment\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=files\r\n\r\n--files\r\nContent-Type: text/plain\r\n\r\nAttachment follows\r\n--files\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename*=UTF-8''${encodeURIComponent(filename)}\r\nContent-Transfer-Encoding: base64\r\n\r\nYWJj\r\n--files--\r\n`,
    );
    const mailbox = await findMailbox(env, "inbox@example.com");
    const result = await storeInbound(
      env,
      mailbox!,
      raw.buffer,
      "sender@example.net",
    );
    const attachment = await env.DB.prepare(
      "SELECT id,filename FROM attachments WHERE message_id=?",
    )
      .bind(result.id)
      .first<{ id: string; filename: string }>();
    expect(attachment?.filename).toBe("a" + "😀".repeat(89));
    const response = await mailboxRequest(
      `/messages/attachments/${attachment!.id}`,
      { headers },
    );
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([97, 98, 99]),
    );
    const downloadedName = decodeURIComponent(
      response.headers.get("Content-Disposition")!.split("UTF-8''")[1],
    );
    expect(downloadedName).toBe(attachment!.filename);
  });

  it("replaces isolated surrogates before a filename is persisted or encoded", () => {
    const filename = safeFilename("broken-\ud800-name-\udc00.txt");
    expect(filename).toBe("broken-\uFFFD-name-\uFFFD.txt");
    expect(() => encodeURIComponent(filename)).not.toThrow();
    expect(safeFilename("z".repeat(179) + "😀")).toBe("z".repeat(179));
  });
});
