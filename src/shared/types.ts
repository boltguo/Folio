export interface Domain {
  id: string;
  name: string;
  status: string;
  receiving_enabled: number;
  sending_enabled: number;
  mailbox_count: number;
  inbound_count: number;
}

export interface Mailbox {
  id: string;
  email: string;
  display_name: string;
  domain_id: string;
  domain_name: string;
  domain_sending_enabled: number;
  enabled: number;
  forward_enabled: number;
  forward_to: string | null;
  received_count: number;
  unread_count: number;
}

export interface Attachment {
  id: string;
  filename: string;
  content_type: string;
  size: number;
}

export interface MailMessage {
  id: string;
  direction: "inbound" | "outbound";
  from_address: string;
  from_name: string | null;
  to_addresses: string[];
  cc_addresses: string[];
  subject: string;
  snippet: string;
  status: string;
  send_error?: string | null;
  is_read: number;
  is_starred: number;
  is_archived: number;
  is_deleted: number;
  has_attachments: number;
  received_at: number;
  mailbox_email: string | null;
  domain_name: string | null;
  delivery_revision?: number;
}

export interface RecipientDelivery {
  address: string;
  recipient_type: "to" | "cc" | "bcc";
  status: string;
  status_updated_at: number;
  error_code: string | null;
  error_message: string | null;
  complained_at: number | null;
}

export interface MessageDetail extends MailMessage {
  message_id: string | null;
  references_header: string | null;
  bcc_addresses: string[];
  reply_to_addresses: string[];
  body_text: string | null;
  body_html: string | null;
  attachments: Attachment[];
  send_error: string | null;
  provider_message_id?: string | null;
  deliveries?: RecipientDelivery[];
  has_raw?: boolean;
}

export interface MessagePage {
  items: MailMessage[];
  total: number;
  limit: number;
  offset: number;
}

export interface InboundFailure {
  id: string;
  recipient: string;
  reason: string;
  raw_object_key: string | null;
  created_at: number;
  resolved_at: number | null;
}

export interface Settings {
  stats: {
    domains: number;
    mailboxes: number;
    messages: number;
    unread: number;
  };
  resendConfigured: boolean;
  webhookConfigured: boolean;
  failures: InboundFailure[];
}

export interface ComposeAttachment {
  filename: string;
  content: string;
  contentType: string;
}
