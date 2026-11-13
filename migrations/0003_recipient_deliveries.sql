ALTER TABLE messages ADD COLUMN delivery_revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE message_deliveries (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  address TEXT NOT NULL COLLATE NOCASE,
  recipient_type TEXT NOT NULL CHECK(recipient_type IN ('to','cc','bcc')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','unknown','sent','delayed','delivered','bounced','failed','suppressed')),
  status_updated_at INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  complained_at INTEGER,
  PRIMARY KEY(message_id, address)
);

-- Deduplicate addresses across To/Cc/Bcc; preserve the first visible role.
WITH declared AS (
  SELECT m.id AS message_id, lower(trim(j.value)) AS address, 0 AS priority
  FROM messages m, json_each(m.to_addresses) j
  WHERE m.direction='outbound' AND j.type='text' AND trim(j.value)<>''
  UNION ALL
  SELECT m.id, lower(trim(j.value)), 1
  FROM messages m, json_each(m.cc_addresses) j
  WHERE m.direction='outbound' AND j.type='text' AND trim(j.value)<>''
  UNION ALL
  SELECT m.id, lower(trim(j.value)), 2
  FROM messages m, json_each(m.bcc_addresses) j
  WHERE m.direction='outbound' AND j.type='text' AND trim(j.value)<>''
), recipients AS (
  SELECT message_id,address,min(priority) AS priority FROM declared GROUP BY message_id,address
), counted AS (
  SELECT *,count(*) OVER (PARTITION BY message_id) AS recipient_count FROM recipients
)
INSERT INTO message_deliveries(message_id,address,recipient_type,status,status_updated_at)
SELECT r.message_id,r.address,CASE r.priority WHEN 0 THEN 'to' WHEN 1 THEN 'cc' ELSE 'bcc' END,
  CASE
    WHEN m.provider_message_id IS NULL AND m.status IN ('pending','unknown','failed') THEN m.status
    WHEN r.recipient_count=1 AND m.status IN ('sent','delayed','delivered','bounced','failed','suppressed') THEN m.status
    WHEN m.provider_message_id IS NOT NULL THEN 'sent'
    ELSE 'pending'
  END,
  CASE WHEN r.recipient_count=1 THEN m.status_updated_at ELSE 0 END
FROM counted r JOIN messages m ON m.id=r.message_id;

-- Old message-level status is ambiguous for multiple recipients. Recover only
-- outcomes that actually identify that recipient. A legacy event without To is
-- safe to associate only when the original email had one recipient.
WITH matching AS (
  SELECT d.message_id,d.address,e.id,e.event_type,e.payload,e.event_timestamp,
    CASE
      WHEN e.event_type IN ('email.bounced','email.failed','email.suppressed') THEN 4
      WHEN e.event_type IN ('email.delivered','email.complained') THEN 3
      WHEN e.event_type='email.delivery_delayed' THEN 2
      ELSE 1
    END AS outcome_rank
  FROM message_deliveries d
  JOIN messages m ON m.id=d.message_id
  JOIN webhook_events e ON e.provider_message_id=m.provider_message_id
  WHERE e.event_type IN ('email.sent','email.delivery_delayed','email.delivered','email.bounced','email.failed','email.suppressed','email.complained')
    AND (
      (json_type(e.payload,'$.data.to')='array' AND EXISTS (
        SELECT 1 FROM json_each(e.payload,'$.data.to') r
        WHERE r.type='text' AND lower(trim(r.value))=d.address
      ))
      OR (json_type(e.payload,'$.data.to') IS NULL AND
        (SELECT count(*) FROM message_deliveries single WHERE single.message_id=d.message_id)=1)
    )
), ranked AS (
  SELECT *,row_number() OVER (
    PARTITION BY message_id,address ORDER BY outcome_rank DESC,event_timestamp DESC,id DESC
  ) AS position FROM matching
)
UPDATE message_deliveries AS d SET
  status=CASE e.event_type
    WHEN 'email.sent' THEN 'sent'
    WHEN 'email.delivery_delayed' THEN 'delayed'
    WHEN 'email.delivered' THEN 'delivered'
    WHEN 'email.complained' THEN 'delivered'
    WHEN 'email.bounced' THEN 'bounced'
    WHEN 'email.suppressed' THEN 'suppressed'
    ELSE 'failed' END,
  status_updated_at=e.event_timestamp,
  error_code=CASE e.event_type
    WHEN 'email.bounced' THEN coalesce(json_extract(e.payload,'$.data.bounce.subType'),json_extract(e.payload,'$.data.bounce.type'),'bounced')
    WHEN 'email.failed' THEN coalesce(json_extract(e.payload,'$.data.failed.reason'),'failed')
    WHEN 'email.suppressed' THEN coalesce(json_extract(e.payload,'$.data.suppressed.type'),'suppressed') END,
  error_message=CASE e.event_type
    WHEN 'email.bounced' THEN substr(json_extract(e.payload,'$.data.bounce.message'),1,1000)
    WHEN 'email.failed' THEN substr(json_extract(e.payload,'$.data.failed.reason'),1,1000)
    WHEN 'email.suppressed' THEN substr(json_extract(e.payload,'$.data.suppressed.message'),1,1000) END
FROM ranked e
WHERE e.position=1 AND e.message_id=d.message_id AND e.address=d.address
  AND e.outcome_rank>=CASE
    WHEN d.status IN ('bounced','failed','suppressed') THEN 4
    WHEN d.status='delivered' THEN 3 WHEN d.status='delayed' THEN 2
    WHEN d.status='sent' THEN 1 ELSE 0 END;

UPDATE message_deliveries AS d SET complained_at=(
  SELECT max(e.event_timestamp) FROM webhook_events e
  JOIN messages m ON m.provider_message_id=e.provider_message_id
  WHERE m.id=d.message_id AND e.event_type='email.complained' AND (
    (json_type(e.payload,'$.data.to')='array' AND EXISTS (
      SELECT 1 FROM json_each(e.payload,'$.data.to') r
      WHERE r.type='text' AND lower(trim(r.value))=d.address
    ))
    OR (json_type(e.payload,'$.data.to') IS NULL AND
      (SELECT count(*) FROM message_deliveries single WHERE single.message_id=d.message_id)=1)
  )
);

WITH totals AS (
  SELECT message_id,count(*) AS total,
    sum(status IN ('bounced','failed','suppressed')) AS failures,
    sum(status='bounced') AS bounced,sum(status='suppressed') AS suppressed,
    sum(status='delivered') AS delivered,sum(status='delayed') AS delayed,
    sum(status='sent') AS sent,sum(status='unknown') AS unknown,
    max(max(status_updated_at,coalesce(complained_at,0))) AS updated_at
  FROM message_deliveries GROUP BY message_id
)
UPDATE messages AS m SET
  status=CASE
    WHEN t.failures=t.total THEN CASE WHEN t.bounced=t.total THEN 'bounced' WHEN t.suppressed=t.total THEN 'suppressed' ELSE 'failed' END
    WHEN t.failures>0 THEN 'partial_failed'
    WHEN t.delivered=t.total THEN 'delivered'
    WHEN t.delivered>0 THEN 'partial_delivered'
    WHEN t.delayed>0 THEN 'delayed'
    WHEN t.sent>0 THEN 'sent'
    WHEN t.unknown>0 THEN 'unknown'
    ELSE 'pending' END,
  status_updated_at=max(m.status_updated_at,t.updated_at),
  delivery_revision=1
FROM totals t WHERE t.message_id=m.id;
