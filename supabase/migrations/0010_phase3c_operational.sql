-- 0010_phase3c_operational.sql
-- Phase 3c operational hardening:
--   1. pipeline_metrics      — per-request latency, LLM token usage, cost estimate
--   2. rate_limit_counters   — sliding-window counter + check_rate_limit() RPC
--   3. daily_llm_cost view   — rolled-up cost-per-day for the dashboard
--   4. recent_pipeline_errors view — operator-friendly error feed

-- ── pipeline_metrics ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pipeline_metrics (
  id                 BIGSERIAL PRIMARY KEY,
  function_name      TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('success','failure','partial')),
  duration_ms        INTEGER NOT NULL CHECK (duration_ms >= 0),
  llm_calls          INTEGER NOT NULL DEFAULT 0,
  llm_input_tokens   INTEGER NOT NULL DEFAULT 0,
  llm_output_tokens  INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd NUMERIC(10,6),
  source_type        TEXT,
  customer_id        TEXT,
  extraction_id      UUID REFERENCES ai_extractions(id) ON DELETE SET NULL,
  error_code         TEXT,
  metadata           JSONB,
  created_at         TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pipeline_metrics_fn_time
  ON pipeline_metrics(function_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_metrics_status
  ON pipeline_metrics(status, created_at DESC) WHERE status != 'success';
CREATE INDEX IF NOT EXISTS idx_pipeline_metrics_extraction
  ON pipeline_metrics(extraction_id) WHERE extraction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pipeline_metrics_customer
  ON pipeline_metrics(customer_id, created_at DESC) WHERE customer_id IS NOT NULL;

ALTER TABLE pipeline_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY pipeline_metrics_read_owner_manager ON pipeline_metrics
  FOR SELECT TO authenticated
  USING (current_user_role() IN ('Owner','Manager'));
CREATE POLICY pipeline_metrics_service ON pipeline_metrics
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── rate_limit_counters ────────────────────────────────────────────────────
-- Fixed-window counter table. Each (bucket_key, window_start) row counts
-- requests in that window. Rows for past windows are kept for ~24h then
-- cleaned by a nightly job (caller-managed; see docs/runbook.md).
CREATE TABLE IF NOT EXISTS rate_limit_counters (
  bucket_key   TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_key, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_window
  ON rate_limit_counters(window_start);

ALTER TABLE rate_limit_counters ENABLE ROW LEVEL SECURITY;
-- Only the service role talks to this table — no human-readable policies needed.
CREATE POLICY rate_limit_service ON rate_limit_counters
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- check_rate_limit RPC: atomic increment-and-check.
-- Returns (allowed, current_count, resets_at). When allowed=false, the caller
-- should respond 429 and surface the resets_at via Retry-After.
CREATE OR REPLACE FUNCTION check_rate_limit(
  p_key             TEXT,
  p_max_per_window  INTEGER,
  p_window_seconds  INTEGER
)
RETURNS TABLE (allowed BOOLEAN, current_count INTEGER, resets_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_window_start TIMESTAMPTZ;
  v_count        INTEGER;
BEGIN
  -- Snap to the window boundary
  v_window_start := to_timestamp(
    floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds
  );

  INSERT INTO rate_limit_counters (bucket_key, window_start, count)
  VALUES (p_key, v_window_start, 1)
  ON CONFLICT (bucket_key, window_start)
  DO UPDATE SET count = rate_limit_counters.count + 1
  RETURNING count INTO v_count;

  RETURN QUERY
    SELECT v_count <= p_max_per_window,
           v_count,
           v_window_start + (p_window_seconds || ' seconds')::INTERVAL;
END;
$$;

GRANT EXECUTE ON FUNCTION check_rate_limit(TEXT, INTEGER, INTEGER) TO service_role;

-- Cleanup helper: delete rate_limit rows older than 24h. Call from cron or
-- run manually as needed.
CREATE OR REPLACE FUNCTION cleanup_rate_limit_counters()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM rate_limit_counters
   WHERE window_start < now() - INTERVAL '24 hours';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;
GRANT EXECUTE ON FUNCTION cleanup_rate_limit_counters() TO service_role;

-- ── observability views ────────────────────────────────────────────────────
CREATE OR REPLACE VIEW daily_llm_cost AS
SELECT
  date_trunc('day', created_at) AS day,
  function_name,
  COUNT(*)                        AS calls,
  SUM(llm_calls)                  AS total_llm_calls,
  SUM(llm_input_tokens)           AS total_input_tokens,
  SUM(llm_output_tokens)          AS total_output_tokens,
  ROUND(SUM(estimated_cost_usd)::NUMERIC, 4) AS total_cost_usd,
  ROUND(AVG(duration_ms)::NUMERIC, 0) AS avg_duration_ms,
  ROUND((PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms))::NUMERIC, 0) AS p95_duration_ms
FROM pipeline_metrics
WHERE created_at > now() - INTERVAL '30 days'
GROUP BY 1, 2
ORDER BY 1 DESC, 2;

CREATE OR REPLACE VIEW recent_pipeline_errors AS
SELECT
  pm.created_at,
  pm.function_name,
  pm.error_code,
  pm.customer_id,
  pm.source_type,
  pm.duration_ms,
  pm.extraction_id,
  pm.metadata
FROM pipeline_metrics pm
WHERE pm.status != 'success'
  AND pm.created_at > now() - INTERVAL '24 hours'
ORDER BY pm.created_at DESC
LIMIT 200;
