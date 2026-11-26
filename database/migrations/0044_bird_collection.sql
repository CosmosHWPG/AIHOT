-- One independently hosted CoreScope Bird session; leases are shared by API and workers.
CREATE TABLE bird_profile_gate (
  profile text PRIMARY KEY,
  lease_owner uuid,
  lease_until timestamptz,
  cooldown_until timestamptz,
  cooldown_reason text,
  verified_user_id text,
  verified_username text,
  credential_fingerprint text,
  verified_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO budgets (service, per_minute, per_hour, per_day, note) VALUES
  ('bird', 1, 10, 120, 'Bird 只读 CLI 调用试点额度；不等于精确 X HTTP 请求数，也不约束 BirdClaw 合计流量')
ON CONFLICT (service) DO NOTHING;
