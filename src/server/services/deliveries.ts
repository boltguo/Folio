import type { RecipientDelivery } from "../../shared/types";
import type { Env } from "../types";

export type DeliveryRecipient = Pick<
  RecipientDelivery,
  "address" | "recipient_type"
>;

export function deliveryRecipients(to: string[], cc: string[], bcc: string[]) {
  const recipients = new Map<string, DeliveryRecipient>();
  for (const [role, addresses] of [
    ["to", to],
    ["cc", cc],
    ["bcc", bcc],
  ] as const) {
    for (const value of addresses) {
      const address = value.trim().toLowerCase();
      if (address && !recipients.has(address))
        recipients.set(address, { address, recipient_type: role });
    }
  }
  return [...recipients.values()];
}

export function seedDeliveryStatements(
  env: Env,
  messageId: string,
  recipients: DeliveryRecipient[],
  status = "pending",
  timestamp = 0,
) {
  return recipients.map((recipient) =>
    env.DB.prepare(
      `INSERT INTO message_deliveries(message_id,address,recipient_type,status,status_updated_at)
       VALUES(?,?,?,?,?) ON CONFLICT(message_id,address) DO NOTHING`,
    ).bind(
      messageId,
      recipient.address,
      recipient.recipient_type,
      status,
      timestamp,
    ),
  );
}

// A final failure must not disappear behind a delayed delivery or an old
// delivered event. Complaints are recorded independently from delivery status.
export const outcomeRank = (status: string) =>
  ["bounced", "failed", "suppressed"].includes(status)
    ? 4
    : status === "delivered"
      ? 3
      : status === "delayed"
        ? 2
        : status === "sent"
          ? 1
          : 0;

export const outcomeRankSql = `CASE
  WHEN status IN ('bounced','failed','suppressed') THEN 4
  WHEN status='delivered' THEN 3 WHEN status='delayed' THEN 2
  WHEN status='sent' THEN 1 ELSE 0 END`;

export function summarizeDeliveryStatement(
  env: Env,
  messageId: string,
  eventId: string,
) {
  return env.DB.prepare(
    `WITH totals AS (
       SELECT count(*) AS total,
         sum(status IN ('bounced','failed','suppressed')) AS failures,
         sum(status='bounced') AS bounced,sum(status='suppressed') AS suppressed,
         sum(status='delivered') AS delivered,sum(status='delayed') AS delayed,
         sum(status='sent') AS sent,sum(status='unknown') AS unknown,
         max(max(status_updated_at,coalesce(complained_at,0))) AS updated_at
       FROM message_deliveries WHERE message_id=?
     )
     UPDATE messages SET
       status=(SELECT CASE
         WHEN failures=total THEN CASE WHEN bounced=total THEN 'bounced' WHEN suppressed=total THEN 'suppressed' ELSE 'failed' END
         WHEN failures>0 THEN 'partial_failed'
         WHEN delivered=total THEN 'delivered'
         WHEN delivered>0 THEN 'partial_delivered'
         WHEN delayed>0 THEN 'delayed'
         WHEN sent>0 THEN 'sent'
         WHEN unknown>0 THEN 'unknown'
         ELSE 'pending' END FROM totals),
       status_updated_at=max(status_updated_at,(SELECT coalesce(updated_at,0) FROM totals)),
       delivery_revision=delivery_revision+1
     WHERE id=? AND (SELECT total FROM totals)>0
       AND EXISTS(SELECT 1 FROM webhook_events WHERE id=? AND processed_at IS NULL)`,
  ).bind(messageId, messageId, eventId);
}
