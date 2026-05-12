-- 0002_error_and_feedback.sql
-- Error logging + ML feedback loop.
-- error_log: every problem the pipeline hits.
-- ml_feedback: every human correction (labelled training example).
-- error_patterns: aggregate view, auto-maintained by trigger.

CREATE TABLE IF NOT EXISTS error_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message       TEXT NOT NULL,
  stack         TEXT,
  context       TEXT,
  severity      TEXT DEFAULT 'error'
                CHECK (severity IN ('info','warning','error','critical')),
  category      TEXT,
  source_type   TEXT,  -- denormalized so trigger can satisfy error_patterns UNIQUE key
  affected_field TEXT,
  reason_code   TEXT,
  user_email    TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_error_log_created  ON error_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_log_severity ON error_log (severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_log_category ON error_log (category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_log_field    ON error_log (affected_field);

CREATE TABLE IF NOT EXISTS ml_feedback (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feedback_type   TEXT NOT NULL,
  source_module   TEXT NOT NULL,
  field_name      TEXT,
  original_value  TEXT,
  corrected_value TEXT,
  context         JSONB,
  extraction_id   UUID REFERENCES ai_extractions(id) ON DELETE SET NULL,
  entity_type     TEXT,
  entity_id       UUID,
  user_email      TEXT,
  user_role       TEXT,
  was_correct     BOOLEAN,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ml_fb_source   ON ml_feedback (source_module, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ml_fb_field    ON ml_feedback (field_name, source_module);
CREATE INDEX IF NOT EXISTS idx_ml_fb_correct  ON ml_feedback (was_correct, source_module);
CREATE INDEX IF NOT EXISTS idx_ml_fb_created  ON ml_feedback (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ml_fb_extid    ON ml_feedback (extraction_id) WHERE extraction_id IS NOT NULL;

-- ── error_patterns: rollup driven by trigger ─────────────────────────────────
CREATE TABLE IF NOT EXISTS error_patterns (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category           TEXT NOT NULL,
  reason_code        TEXT,
  affected_field     TEXT,
  source_type        TEXT NOT NULL DEFAULT 'UNKNOWN',
  occurrence_count   INTEGER NOT NULL DEFAULT 1,
  last_seen          TIMESTAMPTZ NOT NULL DEFAULT now(),
  suggested_fix      TEXT,
  fix_confidence     NUMERIC(3,2),
  is_active          BOOLEAN DEFAULT true,
  created_at         TIMESTAMPTZ DEFAULT now(),
  updated_at         TIMESTAMPTZ DEFAULT now(),
  UNIQUE (category, COALESCE(affected_field, ''), source_type)
);

CREATE INDEX IF NOT EXISTS idx_error_patterns_count  ON error_patterns (occurrence_count DESC);
CREATE INDEX IF NOT EXISTS idx_error_patterns_active ON error_patterns (is_active, occurrence_count DESC);

-- Trigger function: aggregate by (category, affected_field, source_type).
-- Uses MERGE-style UPSERT keyed on the same triple as the UNIQUE constraint.
CREATE OR REPLACE FUNCTION fn_update_error_pattern_on_new_error()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.category IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO error_patterns (
    category, reason_code, affected_field, source_type,
    occurrence_count, last_seen, is_active, created_at, updated_at
  )
  VALUES (
    NEW.category,
    NEW.reason_code,
    NEW.affected_field,
    COALESCE(NEW.source_type, 'UNKNOWN'),
    1, NEW.created_at, true, now(), now()
  )
  ON CONFLICT (category, COALESCE(affected_field, ''), source_type)
  DO UPDATE SET
    occurrence_count = error_patterns.occurrence_count + 1,
    last_seen        = EXCLUDED.last_seen,
    updated_at       = now();

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_error_pattern_aggregation ON error_log;
CREATE TRIGGER trg_error_pattern_aggregation
  AFTER INSERT ON error_log
  FOR EACH ROW EXECUTE FUNCTION fn_update_error_pattern_on_new_error();

-- View: top correction patterns (ML training feedback) keyed on ml_feedback
CREATE OR REPLACE VIEW po_extraction_correction_patterns AS
SELECT
  source_module,
  field_name,
  COUNT(*) AS correction_count,
  COUNT(*) FILTER (WHERE was_correct = false) AS confirmed_errors,
  MAX(created_at) AS last_correction
FROM ml_feedback
WHERE source_module = 'po_extraction'
GROUP BY source_module, field_name
ORDER BY correction_count DESC;
