-- "Ask a question" on a share page. This table only COUNTS questions so one link (or the whole bot) cannot run up the
-- Groq bill. It never stores what was asked or answered.
CREATE TABLE share_questions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL,
  asked_at   INTEGER NOT NULL
);

CREATE INDEX share_questions_by_link ON share_questions (token_hash, asked_at);
CREATE INDEX share_questions_by_time ON share_questions (asked_at);
