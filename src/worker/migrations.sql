-- Run idempotently on every deploy. Each statement is try/catch'd client-side.
ALTER TABLE messages ADD COLUMN sent_at TEXT;
ALTER TABLE messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE messages ADD COLUMN raw_key TEXT;
