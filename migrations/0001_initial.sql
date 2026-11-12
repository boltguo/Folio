PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS domains (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'pending',
  receiving_enabled INTEGER NOT NULL DEFAULT 0,
  sending_enabled INTEGER NOT NULL DEFAULT 0,
  resend_domain_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mailboxes (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  local_part TEXT NOT NULL COLLATE NOCASE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  forward_enabled INTEGER NOT NULL DEFAULT 0,
  forward_to TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(domain_id, local_part)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT REFERENCES mailboxes(id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
  message_id TEXT,
  in_reply_to TEXT,
  references_header TEXT,
  from_address TEXT NOT NULL,
  from_name TEXT,
  to_addresses TEXT NOT NULL DEFAULT '[]',
  cc_addresses TEXT NOT NULL DEFAULT '[]',
  bcc_addresses TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '(no subject)',
  snippet TEXT NOT NULL DEFAULT '',
  body_text TEXT,
  html_object_key TEXT,
  raw_object_key TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  status_updated_at INTEGER NOT NULL DEFAULT 0,
  is_read INTEGER NOT NULL DEFAULT 0,
  is_starred INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL DEFAULT 0,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  provider_message_id TEXT,
  received_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_mailbox_received ON messages(mailbox_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_direction_received ON messages(direction, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(message_id, in_reply_to);
CREATE INDEX IF NOT EXISTS idx_messages_provider ON messages(provider_message_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_dedupe ON messages(mailbox_id, message_id)
  WHERE direction='inbound' AND message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_raw ON messages(mailbox_id, raw_object_key)
  WHERE direction='inbound' AND raw_object_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  content_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS message_recipients (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  mailbox_id TEXT REFERENCES mailboxes(id) ON DELETE SET NULL,
  address TEXT NOT NULL,
  recipient_type TEXT NOT NULL CHECK(recipient_type IN ('to','cc','bcc'))
);
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT REFERENCES mailboxes(id) ON DELETE SET NULL,
  to_addresses TEXT NOT NULL DEFAULT '[]',
  cc_addresses TEXT NOT NULL DEFAULT '[]',
  bcc_addresses TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS send_logs (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'resend',
  provider_message_id TEXT,
  status TEXT NOT NULL,
  error_message TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  payload_key TEXT NOT NULL,
  attempted_at INTEGER,
  lease_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  provider_message_id TEXT,
  event_timestamp INTEGER NOT NULL,
  processed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_provider ON webhook_events(provider_message_id);
CREATE TABLE IF NOT EXISTS inbound_failures (
  id TEXT PRIMARY KEY,
  recipient TEXT NOT NULL,
  message_id TEXT,
  raw_object_key TEXT,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
