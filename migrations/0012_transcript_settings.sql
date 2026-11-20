-- Per-server transcript settings (/transcript-settings): whether a finished recording is SAVED (database, web page, questions)
-- and whether it is POSTED (transcript file and summary into a Discord channel), and an optional fixed channel to post in.
-- A server with no row uses the defaults: save on, post on, post in the channel where the recording was started.
CREATE TABLE transcript_settings (
  guild_id               TEXT PRIMARY KEY,
  save                   INTEGER NOT NULL DEFAULT 1 CHECK (save IN (0, 1)),
  post                   INTEGER NOT NULL DEFAULT 1 CHECK (post IN (0, 1)),
  destination_channel_id TEXT,                       -- NULL = post where the recording was started
  updated_by             TEXT NOT NULL,              -- Discord user id
  updated_at             INTEGER NOT NULL
);

-- The text channel where /start-recording was typed (for a scheduled meeting: the meeting's own channel).
ALTER TABLE recording_sessions ADD COLUMN start_channel_id TEXT;

-- /setup-recording no longer has to name a transcript channel (the channel where the recording was started is the default),
-- so that column becomes optional. SQLite cannot drop NOT NULL in place, so the table is rebuilt with the same rows.
CREATE TABLE recording_setups_new (
  voice_channel_id      TEXT PRIMARY KEY,
  guild_id              TEXT NOT NULL,
  name                  TEXT NOT NULL,
  transcript_channel_id TEXT,
  backup_channel_id     TEXT,
  glossary              TEXT NOT NULL DEFAULT '',
  language              TEXT NOT NULL DEFAULT 'en',
  created_by            TEXT NOT NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
INSERT INTO recording_setups_new (voice_channel_id, guild_id, name, transcript_channel_id, backup_channel_id, glossary, language, created_by, created_at, updated_at)
  SELECT voice_channel_id, guild_id, name, transcript_channel_id, backup_channel_id, glossary, language, created_by, created_at, updated_at FROM recording_setups;
DROP TABLE recording_setups;
ALTER TABLE recording_setups_new RENAME TO recording_setups;
CREATE INDEX recording_setups_by_guild ON recording_setups (guild_id);
