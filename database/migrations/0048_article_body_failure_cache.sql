-- Article/URL failures survive day/format changes and receipt retention. No paid ledger is changed.
CREATE TABLE article_body_failure_cache (
  id bigserial PRIMARY KEY,
  article_id text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  url text NOT NULL,
  url_sha256 text NOT NULL CHECK (url_sha256 ~ '^[a-f0-9]{64}$'),
  service text NOT NULL DEFAULT 'jina' CHECK (service='jina'),
  purpose text NOT NULL DEFAULT 'body_fallback' CHECK (purpose='body_fallback'),
  event_kind text NOT NULL CHECK (event_kind IN ('failure','resolution')),
  reason text CHECK (reason IN ('short_body','target_http_error','verification_interstitial','audited_body_mismatch')),
  -- An evidence pointer, deliberately not a cascading FK to the independently retained ledger.
  receipt_id bigint,
  body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[a-f0-9]{64}$'),
  revision integer,
  via text CHECK (via IN ('readability','jina','rss','structured','history')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  CHECK ((event_kind='failure' AND reason IS NOT NULL AND receipt_id IS NOT NULL AND revision IS NULL AND via IS NULL)
    OR (event_kind='resolution' AND reason IS NULL AND receipt_id IS NULL AND revision IS NOT NULL AND revision>0 AND via IS NOT NULL AND resolved_at IS NULL))
);
CREATE INDEX article_body_failure_scope_idx ON article_body_failure_cache(article_id,url_sha256,created_at DESC);
CREATE UNIQUE INDEX article_body_failure_active_evidence_idx
  ON article_body_failure_cache(article_id,url_sha256,receipt_id,body_sha256,reason)
  WHERE event_kind='failure' AND resolved_at IS NULL;
