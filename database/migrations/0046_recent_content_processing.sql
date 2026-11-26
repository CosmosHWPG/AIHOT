-- Optional rolling news window. Defaults off so existing deployments keep their processing policy.
INSERT INTO settings (key,value,updated_by) VALUES ('content.recent-processing',
  '{"enabled":false,"windowHours":48,"maxRecords":2000,"participationModes":["editorial","hot_signal"],"order":"published_at DESC,id DESC"}',
  'migration') ON CONFLICT(key) DO NOTHING;

CREATE INDEX articles_published_processing_idx ON articles (published_at DESC,id DESC)
  WHERE published_at IS NOT NULL;
