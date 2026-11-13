import type { ComposeAttachment, Mailbox } from "../../shared/types";

export function hasComposeContent(draft: {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  attachments: ComposeAttachment[];
}): boolean {
  return (
    [draft.to, draft.cc, draft.bcc, draft.subject, draft.text].some(
      (value) => value.trim().length > 0,
    ) || draft.attachments.length > 0
  );
}

export function mailboxesForDomain(mailboxes: Mailbox[], domainId: string) {
  return domainId
    ? mailboxes.filter((mailbox) => mailbox.domain_id === domainId)
    : mailboxes;
}

// Never silently change identity when the selected mailbox cannot send.
export function composeSender(
  mailboxes: Mailbox[],
  preferredId = "",
  preferredEmail = "",
) {
  const available = mailboxes.filter(
    (m) => m.enabled && m.domain_sending_enabled,
  );
  if (preferredEmail)
    return available.find((m) => m.email === preferredEmail)?.id || "";
  if (preferredId) return available.find((m) => m.id === preferredId)?.id || "";
  return available[0]?.id || "";
}
