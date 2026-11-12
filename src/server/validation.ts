import { z } from "zod";

export const emailAddress = z.string().trim().email().max(254);
export const headerText = z
  .string()
  .max(998)
  .regex(/^[^\r\n\0]*$/);
export const password = z.string().min(12).max(256);

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
          content: z
            .string()
            .regex(
              /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
            ),
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
      ) <=
      10 * 1024 * 1024,
    "Attachments exceed 10 MiB",
  );
