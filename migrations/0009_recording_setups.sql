-- Per-server recording settings, made with /setup-recording (replaces the TEAM_CONFIG GitHub secret).
-- One row per voice channel: where its transcript and summary are posted. The recorder fetches its row from the Worker.
CREATE TABLE recording_setups (
  voice_channel_id      TEXT PRIMARY KEY,
  guild_id              TEXT NOT NULL,
  name                  TEXT NOT NULL,            -- shown in the transcript heading, e.g. "Design team"
  transcript_channel_id TEXT NOT NULL,            -- private text channel for the transcript and summary
  backup_channel_id     TEXT,                     -- optional private channel for the audio backup
  glossary              TEXT NOT NULL DEFAULT '', -- comma-separated words the transcriber should spell correctly
  language              TEXT NOT NULL DEFAULT 'en',
  created_by            TEXT NOT NULL,            -- Discord user id of the admin who set it up
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE INDEX recording_setups_by_guild ON recording_setups (guild_id);
