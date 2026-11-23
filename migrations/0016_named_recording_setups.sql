-- Named recording setups (/recording setup): per-server routing profiles for different kinds of meeting. Each one says where a
-- recording's results go:
--   private_channel_id  the transcript file (and the audio, when `audio` is on): private content, for a private channel
--   summary_channel_id  the summary message with the link to the summary page
--   link_channel_id     a "recording is ready" message with a Discord link to the transcript message (only people who can see the
--                       private channel can open it, so no private content is posted there)
-- A NULL channel means "the place it would go without a named setup" (see resolveRouting in src/recording-store.js).
-- The setup named "Default" (name_key 'default') is used by every recording whose meeting chose none, or chose one that no longer
-- exists. A server that never made a "Default" row gets a built-in one with every channel NULL (exactly the older behaviour).
-- This is separate from recording_setups (/setup-recording, one row per voice channel), which still decides which voice channels
-- may be recorded at all and holds their name, language and glossary.
CREATE TABLE named_recording_setups (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id           TEXT NOT NULL,
  name               TEXT NOT NULL,
  name_key           TEXT NOT NULL,            -- lowercased, whitespace-collapsed name
  private_channel_id TEXT,
  summary_channel_id TEXT,
  link_channel_id    TEXT,
  audio              INTEGER NOT NULL DEFAULT 0 CHECK (audio IN (0, 1)), -- 1 = also post the audio in the private channel
  created_by         TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE (guild_id, name_key)
);

-- The named setup a meeting or preset uses (its display name; matched case-insensitively). NULL = the Default setup.
-- Kept by name, not id, like presets: a setup that is deleted and made again is found again, and a missing one falls back to Default.
ALTER TABLE meetings ADD COLUMN recording_setup TEXT;
ALTER TABLE presets ADD COLUMN recording_setup TEXT;

-- What a recording session was routed with, fixed when it starts (so editing a setup mid-meeting cannot move a transcript).
ALTER TABLE recording_sessions ADD COLUMN setup_name TEXT;            -- the named setup actually used ('Default' after a fallback)
ALTER TABLE recording_sessions ADD COLUMN private_channel_id TEXT;
ALTER TABLE recording_sessions ADD COLUMN summary_channel_id TEXT;
ALTER TABLE recording_sessions ADD COLUMN link_channel_id TEXT;
ALTER TABLE recording_sessions ADD COLUMN audio_channel_id TEXT;
-- The start time of the meeting occurrence this session records. With meeting_id it is unique, so a start job delivered twice can
-- never make a second session (and so never a second recording or a second set of posts) for the same occurrence.
ALTER TABLE recording_sessions ADD COLUMN meeting_fire_at INTEGER;
CREATE UNIQUE INDEX recording_sessions_one_per_occurrence
  ON recording_sessions (meeting_id, meeting_fire_at) WHERE meeting_id IS NOT NULL AND meeting_fire_at IS NOT NULL;
