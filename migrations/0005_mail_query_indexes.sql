-- Foreign keys do not create indexes automatically in SQLite/D1.
-- These lookups run for each list item and when opening a message.
CREATE INDEX IF NOT EXISTS idx_send_logs_message ON send_logs(message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

-- Settings polls only unresolved failures, newest first.
CREATE INDEX IF NOT EXISTS idx_inbound_failures_unresolved
  ON inbound_failures(created_at DESC) WHERE resolved_at IS NULL;
