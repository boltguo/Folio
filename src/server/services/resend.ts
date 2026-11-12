import type { Env } from "../types";

export interface SendPayload {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text?: string;
  html?: string;
  reply_to?: string;
  headers: Record<string, string>;
  attachments: { filename: string; content: string; content_type: string }[];
}

export class ResendError extends Error {
  constructor(
    message: string,
    public readonly uncertain: boolean,
  ) {
    super(message);
  }
}

export async function sendWithResend(
  env: Env,
  payload: SendPayload,
  key: string,
): Promise<string> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await response.json()) as {
    id?: string;
    message?: string;
    name?: string;
  };
  if (!response.ok)
    throw new ResendError(
      data.message || data.name || `Resend request failed (${response.status})`,
      response.status >= 500 || [408, 409, 429].includes(response.status),
    );
  if (!data.id)
    throw new ResendError("Resend did not return a message id", true);
  return data.id;
}

export async function getResendMessageId(
  env: Env,
  providerId: string,
): Promise<string | null> {
  const response = await fetch(
    `https://api.resend.com/emails/${encodeURIComponent(providerId)}`,
    {
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` },
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!response.ok)
    throw new Error(`Resend message lookup failed (${response.status})`);
  const result = (await response.json()) as { message_id?: string };
  return result.message_id || null;
}
