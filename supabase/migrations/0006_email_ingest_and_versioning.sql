-- 0006_email_ingest_and_versioning.sql
-- Adds:
--   1. Versioning columns on ai_extractions so revisions supersede prior versions
--   2. email_ingest_log to track every email seen by ingest-email (PO or not)
--   3. RLS on email_ingest_log mirroring other tables

-- ── ai_extractions versioning ───────────────────────────────────────────────
ALTER TABLE ai_extractions
  ADD COLUMN IF NOT EXISTS version_number     INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS is_current_version BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS superseded_by_id   UUID REFERENCES ai_extractions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS revision_diff      JSONB;

-- Only the current version per (customer_id, po_id) should appear in default lookups.
CREATE INDEX IF NOT EXISTS idx_ai_extractions_current_version
  ON ai_extractions (customer_id, (payload->'metadata'->>'po_id'))
  WHERE is_current_version = true;

CREATE INDEX IF NOT EXISTS idx_ai_extractions_supersede
  ON ai_extractions (superseded_by_id)
  WHERE superseded_by_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_extractions_version_lookup
  ON ai_extractions (customer_id, (payload->'metadata'->>'po_id'), version_number DESC);

-- Convenience view: latest version per (customer, po_id)
CREATE OR REPLACE VIEW current_purchase_orders AS
SELECT *
FROM ai_extractions
WHERE kind = 'purchase_order' AND is_current_version = true;

-- ── email_ingest_log ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_ingest_log (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id             TEXT,
  from_address           TEXT,
  subject                TEXT,
  received_at            TIMESTAMPTZ DEFAULT now(),
  classification         TEXT NOT NULL
                         CHECK (classification IN ('PO','NOT_PO','SKIPPED','ERROR')),
  classifier_confidence  NUMERIC(4,3),
  classifier_reason      TEXT,
  classifier_model       TEXT,
  extraction_id          UUID REFERENCES ai_extractions(id) ON DELETE SET NULL,
  customer_id            TEXT,
  raw_size_bytes         INTEGER,
  processing_ms          INTEGER,
  error_detail           TEXT
);

CREATE INDEX IF NOT EXISTS idx_email_ingest_classification
  ON email_ingest_log (classification, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_ingest_from
  ON email_ingest_log (from_address, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_ingest_message_id
  ON email_ingest_log (message_id)
  WHERE message_id IS NOT NULL;

-- Idempotency: prevent re-processing the same Message-ID
CREATE UNIQUE INDEX IF NOT EXISTS uniq_email_ingest_message_id
  ON email_ingest_log (message_id)
  WHERE message_id IS NOT NULL;

ALTER TABLE email_ingest_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY email_ingest_read_owner_manager ON email_ingest_log
  FOR SELECT TO authenticated
  USING (current_user_role() IN ('Owner','Manager'));

CREATE POLICY email_ingest_service ON email_ingest_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);
