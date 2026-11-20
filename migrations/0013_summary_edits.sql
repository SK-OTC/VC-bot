-- Edits to the summary made on the /admin page. The generated summary_text is never changed: an edit is kept beside it, so it
-- can always be restored. The transcript text and its chunks are not touched by editing.
ALTER TABLE transcripts ADD COLUMN summary_edited TEXT;       -- NULL = not edited
ALTER TABLE transcripts ADD COLUMN summary_edited_at INTEGER;
