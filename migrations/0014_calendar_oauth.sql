-- Google Calendar through the organiser's own Google sign-in (OAuth), alongside the older Apps Script bridge
-- (calendar_accounts, migration 0003), which keeps working for anyone who connected it.

-- One row per project manager. team_id is the Discord server (guild) the PM connected in; a connection is only ever used for that
-- server's meetings and guest teams.
CREATE TABLE calendar_connections (
  discord_user_id        TEXT PRIMARY KEY,
  team_id                TEXT NOT NULL,
  google_email           TEXT NOT NULL,
  -- AES-GCM ciphertext and its random per-record IV, both base64. Never plain text. NULL once disconnected (the token is wiped).
  encrypted_refresh_token TEXT,
  iv                     TEXT,
  status                 TEXT NOT NULL CHECK (status IN ('connected', 'disconnected')),
  token_issued_at        INTEGER NOT NULL,          -- unix seconds: when Google issued this refresh token (the sign-in)
  last_refresh_at        INTEGER,                   -- unix seconds of the last refresh attempt (NULL = never)
  last_refresh_result    TEXT,                      -- 'ok', 'invalid_grant', 'error: <short reason>'; never contains a token
  -- A connected row always has a token; a disconnected row never keeps one.
  CHECK ((status = 'connected' AND encrypted_refresh_token IS NOT NULL AND iv IS NOT NULL)
      OR (status = 'disconnected' AND encrypted_refresh_token IS NULL AND iv IS NULL))
);

CREATE INDEX calendar_connections_team ON calendar_connections (team_id);

-- One-time codes for the sign-in link (the OAuth "state"). Only a SHA-256 hash of the code is stored, so a copy of this table
-- cannot be used to complete someone else's sign-in.
CREATE TABLE calendar_connect_codes (
  code            TEXT PRIMARY KEY,                 -- SHA-256 of the code, hex
  discord_user_id TEXT NOT NULL,
  team_id         TEXT NOT NULL,
  expires_at      INTEGER NOT NULL,                 -- unix seconds; 10 minutes after creation
  used            INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX calendar_connect_codes_expiry ON calendar_connect_codes (expires_at);
