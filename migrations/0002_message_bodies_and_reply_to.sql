-- Keep legacy body_text values readable; new bodies live in R2.
ALTER TABLE messages ADD COLUMN text_object_key TEXT;
-- NULL identifies legacy messages whose Reply-To was not persisted.
ALTER TABLE messages ADD COLUMN reply_to_addresses TEXT;
