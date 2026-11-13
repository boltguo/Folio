import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { MessagePage } from "../src/shared/types";
import {
  mailboxAuthorization,
  mailboxRequest,
  seedMailbox,
} from "./mailbox-fixtures";

let headers: HeadersInit;
beforeEach(async () => {
  headers = await mailboxAuthorization();
  await seedMailbox();
});

async function seedMessage(
  id: string,
  options: {
    name?: string;
    to?: string[];
    cc?: string[];
    bcc?: string[];
    direction?: "inbound" | "outbound";
    archived?: number;
    deleted?: number;
  } = {},
) {
  await env.DB.prepare(
    `INSERT INTO messages(id,mailbox_id,direction,from_address,from_name,to_addresses,cc_addresses,bcc_addresses,is_archived,is_deleted,received_at,created_at)
     VALUES(?,'mailbox',?,'sender@example.net',?,?,?,?,?,?,1,1)`,
  )
    .bind(
      id,
      options.direction || "inbound",
      options.name || null,
      JSON.stringify(options.to || []),
      JSON.stringify(options.cc || []),
      JSON.stringify(options.bcc || []),
      options.archived || 0,
      options.deleted || 0,
    )
    .run();
}

async function search(query: string, folder = "inbox") {
  const response = await mailboxRequest(
    `/messages?${new URLSearchParams({ q: query, folder })}`,
    { headers },
  );
  expect(response.status).toBe(200);
  return response.json<MessagePage>();
}

describe("practical literal mail search", () => {
  it("finds display names and addresses in To, Cc and Bcc", async () => {
    await seedMessage("name", { name: "Ada Lovelace" });
    await seedMessage("to", { to: ["billing+Team@example.net"] });
    await seedMessage("cc", { cc: ["Editor_One@example.net"] });
    await seedMessage("bcc", { bcc: ["private@example.net"] });
    for (const [query, id] of [
      ["ada LOVE", "name"],
      ["TEAM@example", "to"],
      ["editor_one", "cc"],
      ["private@", "bcc"],
    ]) {
      const result = await search(query);
      expect(result.items.map((message) => message.id)).toEqual([id]);
      expect(result.total).toBe(1);
    }
  });

  it("searches attachment filenames literally without duplicating mail rows", async () => {
    await seedMessage("files");
    await seedMessage("other");
    for (const id of ["first", "second"])
      await env.DB.prepare(
        "INSERT INTO attachments(id,message_id,filename,content_type,size,r2_key,created_at) VALUES(?,'files',?,'application/pdf',1,?,1)",
      )
        .bind(id, `report_100%_O'Reilly_${id}.pdf`, id)
        .run();
    const result = await search("100%_O'Reilly");
    expect(result.items.map((message) => message.id)).toEqual(["files"]);
    expect(result.total).toBe(1);
    expect((await search("%")).total).toBe(1);
    expect((await search("%anything%")).total).toBe(0);
  });

  it("matches address values rather than JSON punctuation", async () => {
    await seedMessage("recipients", { to: ["recipient@example.net"] });
    expect((await search('["')).total).toBe(0);
    expect((await search("' OR 1=1 --")).total).toBe(0);
  });

  it("keeps the selected folder scope for new search fields", async () => {
    const to = ["target@example.net"];
    await seedMessage("inbox", { to });
    await seedMessage("sent", { to, direction: "outbound" });
    await seedMessage("archive", { to, archived: 1 });
    await seedMessage("trash", { to, deleted: 1 });
    for (const folder of ["inbox", "sent", "archive", "trash"])
      expect(
        (await search("target@example", folder)).items.map(
          (message) => message.id,
        ),
      ).toEqual([folder]);
  });
});
