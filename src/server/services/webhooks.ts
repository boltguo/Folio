import { z } from "zod";
import type { Env } from "../types";
import { now } from "../lib";

export const webhookInput = z.object({
  type: z.string(),
  created_at: z.string().datetime({ offset: true }).optional(),
  data: z.object({
    email_id: z.string().optional(),
    message_id: z.string().optional(),
  }),
});
type WebhookEvent = z.infer<typeof webhookInput>;
const statuses: Record<string, string> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.delivery_delayed": "delayed",
};

export async function reconcileWebhooks(env: Env, providerId: string) {
  const events = await env.DB.prepare(
    "SELECT id,payload,event_timestamp FROM webhook_events WHERE provider_message_id=? AND processed_at IS NULL ORDER BY event_timestamp,id",
  )
    .bind(providerId)
    .all<{ id: string; payload: string; event_timestamp: number }>();
  for (const row of events.results) {
    const event: WebhookEvent = webhookInput.parse(JSON.parse(row.payload)),
      status = statuses[event.type];
    const statements: D1PreparedStatement[] = [];
    if (status)
      statements.push(
        env.DB.prepare(
          `
      UPDATE messages SET status=?,status_updated_at=? WHERE provider_message_id=?
      AND status_updated_at<=?
      AND (status NOT IN ('delivered','bounced') OR ? IN ('delivered','bounced'))
      AND NOT (status='delayed' AND ?='sent')
    `,
        ).bind(
          status,
          row.event_timestamp,
          providerId,
          row.event_timestamp,
          status,
          status,
        ),
      );
    if (event.data.message_id)
      statements.push(
        env.DB.prepare(
          "UPDATE messages SET message_id=? WHERE provider_message_id=?",
        ).bind(event.data.message_id, providerId),
      );
    statements.push(
      env.DB.prepare(
        `UPDATE webhook_events SET processed_at=? WHERE id=? AND EXISTS (SELECT 1 FROM messages WHERE provider_message_id=?)`,
      ).bind(now(), row.id, providerId),
    );
    await env.DB.batch(statements);
  }
}
