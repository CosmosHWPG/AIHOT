-- Raw-material bridge receipts and progress live in the independent site's DB.
-- An article write, queue job, ledger acknowledgment and cursor commit together.
CREATE TABLE corescope_bridge_state (
  client text PRIMARY KEY,
  cursor jsonb,
  initial_since timestamptz,
  last_ok_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  imported_count bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE corescope_bridge_ledger (
  client text NOT NULL REFERENCES corescope_bridge_state(client),
  upstream_id bigint NOT NULL,
  upstream_article_id text,
  source_alias text NOT NULL,
  source_id text NOT NULL REFERENCES sources(id),
  article_id text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  raw_fingerprint text NOT NULL,
  upstream_updated_at timestamptz,
  body_evidence jsonb NOT NULL,
  source_evidence jsonb NOT NULL DEFAULT '[]',
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client, upstream_id)
);
CREATE INDEX corescope_bridge_ledger_updated_idx ON corescope_bridge_ledger (client, upstream_updated_at);
