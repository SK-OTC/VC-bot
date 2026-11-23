-- /transcript-settings and /setup-recording were folded into /recording. Two ways of choosing where a transcript goes were removed:
--   transcript_settings.destination_channel_id  (/transcript-settings destination)  -> becomes the Default setup's private channel
--   recording_setups.transcript_channel_id      (/setup-recording transcript_channel) -> no longer used (owner's choice); the column
--                                                                                        is left in place but nothing reads it
-- After this, a transcript goes to its recording setup's private channel (a named setup's blanks come from Default), else to the
-- channel where the recording was started. save/post stay per server in transcript_settings.

-- 1. Recordings running while this is deployed keep the channel they would have used before.
UPDATE recording_sessions
SET private_channel_id = COALESCE(
  (SELECT t.destination_channel_id FROM transcript_settings t WHERE t.guild_id = recording_sessions.guild_id),
  (SELECT r.transcript_channel_id FROM recording_setups r WHERE r.voice_channel_id = recording_sessions.voice_channel_id)
)
WHERE status IN ('starting', 'running') AND private_channel_id IS NULL;

-- 2. Audio is only ever posted in a channel an admin named as private. A named setup with audio on and no private channel of its own
--    posts no audio today when the Default has no private channel; step 3 may give the Default one (the old destination, which was
--    never checked for privacy), so audio is switched off for exactly those setups rather than starting to appear there.
UPDATE named_recording_setups
SET audio = 0
WHERE audio = 1 AND private_channel_id IS NULL AND name_key != 'default'
  AND NOT EXISTS (
    SELECT 1 FROM named_recording_setups d
    WHERE d.guild_id = named_recording_setups.guild_id AND d.name_key = 'default' AND d.private_channel_id IS NOT NULL
  );

-- 3. The old destination becomes the Default setup's private channel, unless the Default already names one (that one already won).
UPDATE named_recording_setups
SET private_channel_id = (SELECT t.destination_channel_id FROM transcript_settings t WHERE t.guild_id = named_recording_setups.guild_id)
WHERE name_key = 'default' AND private_channel_id IS NULL
  AND EXISTS (SELECT 1 FROM transcript_settings t WHERE t.guild_id = named_recording_setups.guild_id AND t.destination_channel_id IS NOT NULL);

INSERT INTO named_recording_setups (guild_id, name, name_key, private_channel_id, summary_channel_id, link_channel_id, audio, created_by, created_at, updated_at)
SELECT t.guild_id, 'Default', 'default', t.destination_channel_id, NULL, NULL, 0, t.updated_by, t.updated_at, t.updated_at
FROM transcript_settings t
WHERE t.destination_channel_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM named_recording_setups n WHERE n.guild_id = t.guild_id AND n.name_key = 'default');

UPDATE transcript_settings SET destination_channel_id = NULL;
