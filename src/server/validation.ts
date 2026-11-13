import { z } from "zod";

export const emailAddress = z.string().trim().email().max(254);
export const headerText = z
  .string()
  .max(998)
  .regex(/^[^\r\n\0]*$/);
export const password = z.string().min(12).max(256);

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const maxBase64Length = 4 * Math.ceil(MAX_ATTACHMENT_BYTES / 3);

// A repeated four-character regex group can exhaust V8's regexp stack on
// valid, multi-megabyte files. Check the shape, then scan for invalid bytes.
export function isBase64(value: string): boolean {
  if (value.length > maxBase64Length || value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return !/[^A-Za-z0-9+/]/.test(value.slice(0, value.length - padding));
}

export const attachmentContent = z
  .string()
  .max(maxBase64Length, "Attachments exceed 10 MiB")
  .refine(isBase64, "Invalid base64 attachment");

export const sendInput = z
  .object({
    mailboxId: z.string().min(1),
    to: z.array(emailAddress).min(1).max(50),
    cc: z.array(emailAddress).max(50).default([]),
    bcc: z.array(emailAddress).max(50).default([]),
    subject: headerText.default(""),
    text: z.string().max(500_000).optional(),
    html: z.string().max(500_000).optional(),
    replyTo: emailAddress.optional(),
    inReplyTo: headerText.optional(),
    references: headerText.optional(),
    attachments: z
      .array(
        z.object({
          filename: z.string().min(1).max(180),
          content: attachmentContent,
          contentType: z
            .string()
            .regex(/^[\w.+-]+\/[\w.+-]+$/)
            .default("application/octet-stream"),
        }),
      )
      .max(10)
      .default([]),
  })
  .refine(
    (b) => !!(b.text?.trim() || b.html?.trim()),
    "A message body is required",
  )
  .refine(
    (b) => b.to.length + b.cc.length + b.bcc.length <= 50,
    "Maximum 50 recipients in total",
  )
  .refine(
    (b) =>
      b.attachments.reduce(
        (sum, a) =>
          sum +
          Math.floor((a.content.length * 3) / 4) -
          (a.content.endsWith("==") ? 2 : a.content.endsWith("=") ? 1 : 0),
        0,
      ) <= MAX_ATTACHMENT_BYTES,
    "Attachments exceed 10 MiB",
  );
