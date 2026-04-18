CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  from_addr TEXT NOT NULL,
  subject TEXT,
  sent_at TEXT,
  received_at TEXT NOT NULL,
  text TEXT,
  html TEXT,
  headers_json TEXT NOT NULL,
  links_json TEXT NOT NULL,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  raw_key TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_addr);
CREATE INDEX IF NOT EXISTS idx_messages_received ON messages(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_domain ON messages(domain);
