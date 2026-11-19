-- Semantic search state for long transcripts. The vectors themselves live in Cloudflare Vectorize (one namespace per
-- transcript); these columns only record whether a transcript has been indexed and when indexing was last tried.
ALTER TABLE transcripts ADD COLUMN embedded_at INTEGER;     -- set when every chunk is in the vector index
ALTER TABLE transcripts ADD COLUMN embed_tried_at INTEGER;  -- last attempt, so a failing index is not hammered
