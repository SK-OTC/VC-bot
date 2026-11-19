-- Private web links for transcripts: https://<worker>/t/<token>.
-- Only a SHA-256 hash of each token is stored, so a database dump or backup cannot be used to open a link.
-- A link stops working when it expires or is revoked; deleting the transcript deletes its links.
CREATE TABLE share_links (
  token_hash     TEXT PRIMARY KEY,                                        -- hex SHA-256 of the 43-character token
  transcript_id  TEXT NOT NULL REFERENCES transcripts (id) ON DELETE CASCADE,
  created_by     TEXT NOT NULL,                                           -- Discord user id, or 'recorder' for the automatic link
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  revoked_at     INTEGER,
  views          INTEGER NOT NULL DEFAULT 0,
  last_viewed_at INTEGER
);

CREATE INDEX share_links_by_transcript ON share_links (transcript_id);
