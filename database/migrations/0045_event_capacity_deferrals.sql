-- Capacity waits are durable business work, not failed provider attempts.
CREATE TABLE event_job_deferrals (
  queue text NOT NULL CHECK (queue IN ('events.group', 'events.digest')),
  singleton_key text NOT NULL,
  data jsonb NOT NULL,
  retry_at timestamptz NOT NULL,
  remaining_retries integer NOT NULL CHECK (remaining_retries >= 0),
  reason text NOT NULL,
  generation integer NOT NULL DEFAULT 1,
  queued_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (queue, singleton_key)
);

CREATE INDEX event_job_deferrals_due_idx ON event_job_deferrals (retry_at);

-- Historical terminal capacity failures are imported at most once even after job retention.
CREATE TABLE event_capacity_recoveries (
  job_id uuid PRIMARY KEY,
  queue text NOT NULL,
  singleton_key text NOT NULL,
  recovered_at timestamptz NOT NULL DEFAULT now()
);
