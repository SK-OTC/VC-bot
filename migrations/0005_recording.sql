-- Meeting recording: sessions started by /record (or the scheduler), and the transcripts the recorder uploads.
-- Share links and chat limits come later (0006), when that feature is built.

-- ---------- recording sessions ----------
CREATE TABLE recording_sessions (
  id               TEXT PRIMARY KEY,         -- random, letters and digits; also the GitHub workflow input
  voice_channel_id TEXT NOT NULL,
  guild_id         TEXT NOT NULL,
  started_by       TEXT NOT NULL,            -- Discord user id, or 'scheduled'
  meeting_id       INTEGER,                  -- set when started from a scheduled meeting
  github_run_id    TEXT,
  status           TEXT NOT NULL DEFAULT 'starting' CHECK (status IN ('starting', 'running', 'done', 'failed')),
  stop_flag        INTEGER NOT NULL DEFAULT 0 CHECK (stop_flag IN (0, 1)),
  error            TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- At most one live recording per voice channel. The database enforces it, so two people running
-- /record start at the same moment cannot both win.
CREATE UNIQUE INDEX recording_sessions_one_live_per_channel
  ON recording_sessions (voice_channel_id) WHERE status IN ('starting', 'running');

-- ---------- transcripts ----------
CREATE TABLE transcripts (
  id                    TEXT PRIMARY KEY,    -- 6 characters, made by the recorder
  session_id            TEXT,
  guild_id              TEXT NOT NULL,
  voice_channel_id      TEXT NOT NULL,
  post_channel_id       TEXT NOT NULL,       -- the team's transcript channel: every /transcript query is limited to it
  transcript_message_id TEXT NOT NULL,
  summary_message_id    TEXT,
  started_at            INTEGER NOT NULL,    -- unix seconds
  duration_sec          INTEGER NOT NULL,
  speakers              TEXT NOT NULL,       -- JSON: [{ "name": "...", "speaking_sec": 123 }]
  engine                TEXT NOT NULL,
  language              TEXT NOT NULL,
  summary_text          TEXT,
  actions_text          TEXT,
  created_at            INTEGER NOT NULL
);

CREATE INDEX transcripts_by_channel ON transcripts (post_channel_id, started_at DESC);
CREATE INDEX transcripts_by_created ON transcripts (created_at);

-- The transcript text, cut into pieces of about 1,500 characters on line boundaries.
CREATE TABLE transcript_chunks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  transcript_id TEXT NOT NULL REFERENCES transcripts (id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  text          TEXT NOT NULL,
  UNIQUE (transcript_id, seq)
);

-- Full-text index over the chunks (an "external content" index: it stores no second copy of the text).
CREATE VIRTUAL TABLE transcript_chunks_fts USING fts5(text, content = 'transcript_chunks', content_rowid = 'id');

CREATE TRIGGER transcript_chunks_ai AFTER INSERT ON transcript_chunks BEGIN
  INSERT INTO transcript_chunks_fts (rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER transcript_chunks_ad AFTER DELETE ON transcript_chunks BEGIN
  INSERT INTO transcript_chunks_fts (transcript_chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
