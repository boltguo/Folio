import type { Env } from "../types";
import type { SubmissionState } from "../../shared/types";

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
    public readonly code: string,
    public readonly submissionState: Exclude<SubmissionState, "accepted">,
    public readonly retryable: boolean,
    public readonly providerCode?: string,
    public readonly retryAfter?: number,
  ) {
    super(message);
  }
}

function retryDelay(value: string | null) {
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds
    : (Date.parse(value) - Date.now()) / 1000;
  return Number.isFinite(delay) && delay >= 0 ? Math.ceil(delay) : undefined;
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
  const body: unknown = await response.json().catch(() => ({}));
  const fields =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const data = {
    id: typeof fields.id === "string" ? fields.id : undefined,
    message: typeof fields.message === "string" ? fields.message : undefined,
    name: typeof fields.name === "string" ? fields.name : undefined,
  };
  if (!response.ok) {
    const message =
      data.message || data.name || `Resend request failed (${response.status})`;
    if (response.status === 429)
      throw new ResendError(
        message,
        "SEND_RATE_LIMITED",
        "not_accepted",
        true,
        data.name,
        retryDelay(response.headers.get("Retry-After")),
      );
    if (response.status === 409)
      throw new ResendError(
        message,
        "SEND_IDEMPOTENCY_CONFLICT",
        "uncertain",
        data.name !== "invalid_idempotent_request",
        data.name,
      );
    if (
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 408
    )
      throw new ResendError(
        message,
        "SEND_REJECTED",
        "not_accepted",
        false,
        data.name,
      );
    throw new ResendError(
      message,
      "SEND_UNCONFIRMED",
      "uncertain",
      true,
      data.name,
    );
  }
  if (!data.id?.trim())
    throw new ResendError(
      "Resend did not return a message id",
      "SEND_UNCONFIRMED",
      "uncertain",
      true,
    );
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
