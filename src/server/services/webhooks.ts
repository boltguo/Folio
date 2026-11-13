import { z } from "zod";
import type { Env } from "../types";
import { now, parseList } from "../lib";
import {
  deliveryRecipients,
  outcomeRank,
  outcomeRankSql,
  seedDeliveryStatements,
  summarizeDeliveryStatement,
} from "./deliveries";

export const webhookInput = z.object({
  type: z.string(),
  created_at: z.string().datetime({ offset: true }).optional(),
  data: z.object({
    email_id: z.string().optional(),
    message_id: z.string().optional(),
    to: z.array(z.string()).optional(),
    bounce: z
      .object({
        type: z.string().optional(),
        subType: z.string().optional(),
        message: z.string().optional(),
        diagnosticCode: z.union([z.string(), z.array(z.string())]).optional(),
      })
      .optional(),
    failed: z.object({ reason: z.string().optional() }).optional(),
    suppressed: z
      .object({
        type: z.string().optional(),
        message: z.string().optional(),
      })
      .optional(),
  }),
});
type WebhookEvent = z.infer<typeof webhookInput>;
const statuses: Record<string, string> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.delivery_delayed": "delayed",
  "email.failed": "failed",
  "email.suppressed": "suppressed",
  "email.complained": "delivered",
};

function failureDetails(event: WebhookEvent) {
  if (event.type === "email.bounced") {
    const bounce = event.data.bounce;
    const diagnostic = Array.isArray(bounce?.diagnosticCode)
      ? bounce.diagnosticCode.join("; ")
      : bounce?.diagnosticCode;
    return {
      code: bounce?.subType || bounce?.type || "bounced",
      message: (bounce?.message || diagnostic)?.slice(0, 1000) || null,
    };
  }
  if (event.type === "email.failed")
    return {
      code: event.data.failed?.reason || "failed",
      message: event.data.failed?.reason?.slice(0, 1000) || null,
    };
  if (event.type === "email.suppressed")
    return {
      code: event.data.suppressed?.type || "suppressed",
      message: event.data.suppressed?.message?.slice(0, 1000) || null,
    };
  return { code: null, message: null };
}

export async function reconcileWebhooks(env: Env, providerId: string) {
  const message = await env.DB.prepare(
    `SELECT id,to_addresses,cc_addresses,bcc_addresses,status,status_updated_at
     FROM messages WHERE provider_message_id=? AND direction='outbound'`,
  )
    .bind(providerId)
    .first<{
      id: string;
      to_addresses: string;
      cc_addresses: string;
      bcc_addresses: string;
      status: string;
      status_updated_at: number;
    }>();
  // Events may arrive before the send response is saved. Leave them pending.
  if (!message) return;
  const recipients = deliveryRecipients(
    parseList(message.to_addresses),
    parseList(message.cc_addresses),
    parseList(message.bcc_addresses),
  );
  const seedStatus =
    recipients.length === 1 && outcomeRank(message.status) > 0
      ? message.status
      : "sent";
  const seeds = seedDeliveryStatements(
    env,
    message.id,
    recipients,
    seedStatus,
    recipients.length === 1 ? message.status_updated_at : 0,
  );
  if (seeds.length) await env.DB.batch(seeds);
  const events = await env.DB.prepare(
    "SELECT id,payload,event_timestamp FROM webhook_events WHERE provider_message_id=? AND processed_at IS NULL ORDER BY event_timestamp,id",
  )
    .bind(providerId)
    .all<{ id: string; payload: string; event_timestamp: number }>();
  for (const row of events.results) {
    const event: WebhookEvent = webhookInput.parse(JSON.parse(row.payload)),
      status = statuses[event.type];
    const statements: D1PreparedStatement[] = [];
    const reported =
      event.data.to === undefined && recipients.length === 1
        ? [recipients[0].address]
        : event.data.to || [];
    const authorized = new Set(
      recipients.map((recipient) => recipient.address),
    );
    const targets = [
      ...new Set(reported.map((address) => address.trim().toLowerCase())),
    ].filter((address) => authorized.has(address));
    if (status && targets.length) {
      const detail = failureDetails(event);
      for (const address of targets) {
        const rank = outcomeRank(status);
        statements.push(
          env.DB.prepare(
            `UPDATE message_deliveries SET status=?,status_updated_at=?,error_code=?,error_message=?
           WHERE message_id=? AND address=?
             AND (? > (${outcomeRankSql}) OR (? = (${outcomeRankSql}) AND status_updated_at<=?))
             AND EXISTS(SELECT 1 FROM webhook_events WHERE id=? AND processed_at IS NULL)`,
          ).bind(
            status,
            row.event_timestamp,
            detail.code,
            detail.message,
            message.id,
            address,
            rank,
            rank,
            row.event_timestamp,
            row.id,
          ),
        );
        if (event.type === "email.complained")
          statements.push(
            env.DB.prepare(
              `UPDATE message_deliveries SET complained_at=max(coalesce(complained_at,0),?)
             WHERE message_id=? AND address=?
               AND EXISTS(SELECT 1 FROM webhook_events WHERE id=? AND processed_at IS NULL)`,
            ).bind(row.event_timestamp, message.id, address, row.id),
          );
      }
      statements.push(summarizeDeliveryStatement(env, message.id, row.id));
    }
    if (event.data.message_id)
      statements.push(
        env.DB.prepare(
          `UPDATE messages SET message_id=? WHERE id=?
           AND EXISTS(SELECT 1 FROM webhook_events WHERE id=? AND processed_at IS NULL)`,
        ).bind(event.data.message_id, message.id, row.id),
      );
    statements.push(
      env.DB.prepare(
        `UPDATE webhook_events SET processed_at=? WHERE id=? AND processed_at IS NULL`,
      ).bind(now(), row.id),
    );
    await env.DB.batch(statements);
  }
}
