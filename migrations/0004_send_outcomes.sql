ALTER TABLE send_logs ADD COLUMN submission_state TEXT NOT NULL DEFAULT 'not_accepted'
  CHECK(submission_state IN ('not_accepted','uncertain','accepted'));
ALTER TABLE send_logs ADD COLUMN retryable INTEGER NOT NULL DEFAULT 1;
ALTER TABLE send_logs ADD COLUMN can_edit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE send_logs ADD COLUMN error_code TEXT;
ALTER TABLE send_logs ADD COLUMN retry_after INTEGER NOT NULL DEFAULT 0;

UPDATE send_logs SET
  submission_state=CASE
    WHEN provider_message_id IS NOT NULL OR EXISTS (
      SELECT 1 FROM messages m WHERE m.id=send_logs.message_id AND m.provider_message_id IS NOT NULL
    ) THEN 'accepted'
    WHEN status='pending' AND attempted_at IS NULL AND lease_until=0 THEN 'not_accepted'
    ELSE 'uncertain' END,
  retryable=CASE WHEN provider_message_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM messages m WHERE m.id=send_logs.message_id AND m.provider_message_id IS NOT NULL
  ) THEN 0 ELSE 1 END,
  can_edit=0,
  error_code=CASE WHEN status IN ('failed','unknown') THEN 'SEND_UNCONFIRMED' END;

-- Legacy "failed" could follow an earlier unconfirmed request. Without an
-- explicit rejection history it must keep the original payload and key.
