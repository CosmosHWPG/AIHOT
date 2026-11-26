-- Xquik attempts reserve their worst-case credit cost before any request is sent.
-- Unknown outcomes keep the reservation; rolling limits count retries as well.
ALTER TABLE receipt_attempts ADD COLUMN reserved_credits integer NOT NULL DEFAULT 0
  CHECK (reserved_credits >= 0);

INSERT INTO budgets (service, per_minute, per_hour, per_day, note) VALUES
  ('xquik', 2, 20, 120, 'X 读取请求熔断；另受私有配置的每日 credit 上限与余额保留约束')
ON CONFLICT (service) DO NOTHING;
