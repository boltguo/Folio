import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { MessagePage } from "../src/shared/types";
import {
  mailboxAuthorization,
  mailboxRequest,
  seedMailbox,
} from "./mailbox-fixtures";

it("includes delivery revisions and send errors in list refreshes", async () => {
  const headers = await mailboxAuthorization();
  await seedMailbox();
  await env.DB.prepare(
    "INSERT INTO messages(id,mailbox_id,direction,from_address,status,delivery_revision,received_at,created_at) VALUES('sent','mailbox','outbound','inbox@example.com','failed',3,1,1)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO send_logs(id,message_id,status,error_message,idempotency_key,payload_hash,payload_key,created_at) VALUES('log','sent','failed','Sender domain is not verified','key','hash','payload',1)",
  ).run();
  const response = await mailboxRequest("/messages?folder=sent", { headers });
  expect(response.status).toBe(200);
  const result = await response.json<MessagePage>();
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({
    id: "sent",
    status: "failed",
    delivery_revision: 3,
    send_error: "Sender domain is not verified",
  });
});
