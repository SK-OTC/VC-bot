-- The /admin page saves as you type (autosave). Two people editing the same summary must not silently overwrite each other,
-- so every save and restore increases this number, and a save is only accepted from the version it was started on.
ALTER TABLE transcripts ADD COLUMN summary_version INTEGER NOT NULL DEFAULT 0;
