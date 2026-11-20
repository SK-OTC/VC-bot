-- Daily Cloudflare Neuron meter. The free allowance is 10,000 Neurons per day for the whole account, reset at 00:00 UTC.
-- One row per UTC day, with what each kind of use has spent. Only numbers are stored, never any text.
CREATE TABLE ai_neurons (
  day        TEXT PRIMARY KEY,               -- 'YYYY-MM-DD' in UTC
  summary    REAL NOT NULL DEFAULT 0,        -- reported by the recorder with each transcript upload
  qa         REAL NOT NULL DEFAULT 0,        -- reported by Cloudflare with each answer to a question
  embed      REAL NOT NULL DEFAULT 0,        -- an ESTIMATE: the Workers AI binding does not report usage for embeddings
  updated_at INTEGER NOT NULL
);
