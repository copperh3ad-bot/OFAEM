-- 0009_phase3b_hardening.sql
-- Phase 3b hardening:
--   1. Make migration 0004's policies idempotent on re-run
--      (re-issued with DROP IF EXISTS guards so a fresh db push succeeds twice)
--   2. PII scope: ai_extractions.raw_content moves to a separate, more
--      tightly-restricted table so Merchandiser/Viewer/QC Inspector cannot
--      read full buyer email bodies / Excel CSV exports.
--   3. Defensive CHECK on ai_extractions.overall_confidence (0..1)
--   4. Self-reference guard on ai_extractions.superseded_by_id

-- ── 1. Re-issue 0004 policies idempotently ──────────────────────────────────
-- These are NO-OP if already in place; they let `supabase db reset` succeed
-- on a fresh clone after migrations have been applied to it before.
DO $$
DECLARE
  pol RECORD;
BEGIN
  -- master_articles
  FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'master_articles' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.master_articles', pol.policyname);
  END LOOP;
  FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ai_extractions' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.ai_extractions', pol.policyname);
  END LOOP;
  FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'proforma_invoices' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.proforma_invoices', pol.policyname);
  END LOOP;
  FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('error_log','ml_feedback','error_patterns','user_profiles') LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname,
      (SELECT tablename FROM pg_policies WHERE policyname = pol.policyname LIMIT 1));
  END LOOP;
END $$;

-- Re-create the policies (this is the original 0004 content re-issued idempotently)
CREATE POLICY master_articles_read_all_authenticated ON master_articles
  FOR SELECT TO authenticated USING (true);
CREATE POLICY master_articles_write_manager_plus ON master_articles
  FOR ALL TO authenticated
  USING (current_user_role() IN ('Owner','Manager'))
  WITH CHECK (current_user_role() IN ('Owner','Manager'));
CREATE POLICY master_articles_service ON master_articles
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY ai_extractions_read_team ON ai_extractions
  FOR SELECT TO authenticated
  USING (current_user_role() IN ('Owner','Manager','Merchandiser','Viewer','QC Inspector'));
CREATE POLICY ai_extractions_write_merch_plus ON ai_extractions
  FOR INSERT TO authenticated
  WITH CHECK (current_user_role() IN ('Owner','Manager','Merchandiser'));
CREATE POLICY ai_extractions_update_merch_plus ON ai_extractions
  FOR UPDATE TO authenticated
  USING (current_user_role() IN ('Owner','Manager','Merchandiser'))
  WITH CHECK (current_user_role() IN ('Owner','Manager','Merchandiser'));
CREATE POLICY ai_extractions_delete_owner_manager ON ai_extractions
  FOR DELETE TO authenticated
  USING (current_user_role() IN ('Owner','Manager'));
CREATE POLICY ai_extractions_service ON ai_extractions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY proforma_owner_manager_full ON proforma_invoices
  FOR ALL TO authenticated
  USING (current_user_role() IN ('Owner','Manager'))
  WITH CHECK (current_user_role() IN ('Owner','Manager'));
CREATE POLICY proforma_merchandiser_select ON proforma_invoices
  FOR SELECT TO authenticated
  USING (current_user_role() = 'Merchandiser');
CREATE POLICY proforma_merchandiser_insert ON proforma_invoices
  FOR INSERT TO authenticated
  WITH CHECK (current_user_role() = 'Merchandiser' AND is_ready_for_invoicing = false);
CREATE POLICY proforma_viewer_select ON proforma_invoices
  FOR SELECT TO authenticated
  USING (current_user_role() = 'Viewer');
CREATE POLICY proforma_service ON proforma_invoices
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY error_log_insert_any_authed ON error_log
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY ml_feedback_insert_any_authed ON ml_feedback
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY error_log_read_owner_manager ON error_log
  FOR SELECT TO authenticated USING (current_user_role() IN ('Owner','Manager'));
CREATE POLICY ml_feedback_read_owner_manager ON ml_feedback
  FOR SELECT TO authenticated USING (current_user_role() IN ('Owner','Manager'));
CREATE POLICY error_patterns_read_owner_manager ON error_patterns
  FOR SELECT TO authenticated USING (current_user_role() IN ('Owner','Manager'));
CREATE POLICY error_log_service ON error_log FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY ml_feedback_service ON ml_feedback FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY error_patterns_service ON error_patterns FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY user_profiles_self_read ON user_profiles
  FOR SELECT TO authenticated USING (id = auth.uid());
CREATE POLICY user_profiles_owner_read_all ON user_profiles
  FOR SELECT TO authenticated USING (current_user_role() = 'Owner');
CREATE POLICY user_profiles_owner_manage ON user_profiles
  FOR ALL TO authenticated
  USING (current_user_role() = 'Owner')
  WITH CHECK (current_user_role() = 'Owner');
CREATE POLICY user_profiles_service ON user_profiles
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 2. raw_content PII isolation ────────────────────────────────────────────
-- Move ai_extractions.raw_content into a 1:1 child table that only Owner/Manager
-- can SELECT. The main ai_extractions table no longer carries raw buyer text.
CREATE TABLE IF NOT EXISTS ai_extraction_raw_content (
  extraction_id  UUID PRIMARY KEY REFERENCES ai_extractions(id) ON DELETE CASCADE,
  raw_content    TEXT,
  byte_length    INTEGER,
  created_at     TIMESTAMPTZ DEFAULT now()
);

-- Migrate existing data if the source column still has it
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'ai_extractions' AND column_name = 'raw_content'
  ) THEN
    INSERT INTO ai_extraction_raw_content (extraction_id, raw_content, byte_length)
    SELECT id, raw_content, length(coalesce(raw_content, ''))
      FROM ai_extractions
     WHERE raw_content IS NOT NULL
    ON CONFLICT (extraction_id) DO NOTHING;
    -- View current_purchase_orders does SELECT * → depends on every column.
    -- Drop it before the column removal; we recreate it below.
    DROP VIEW IF EXISTS current_purchase_orders;
    ALTER TABLE ai_extractions DROP COLUMN raw_content;
  END IF;
END $$;

-- Recreate the convenience view sans raw_content
CREATE OR REPLACE VIEW current_purchase_orders AS
SELECT *
FROM ai_extractions
WHERE kind = 'purchase_order' AND is_current_version = true;

ALTER TABLE ai_extraction_raw_content ENABLE ROW LEVEL SECURITY;

CREATE POLICY raw_content_read_owner_manager ON ai_extraction_raw_content
  FOR SELECT TO authenticated
  USING (current_user_role() IN ('Owner','Manager'));
CREATE POLICY raw_content_service ON ai_extraction_raw_content
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 3. Defensive constraints ────────────────────────────────────────────────
-- overall_confidence is conceptually 0..1; the existing NUMERIC(4,3) accepted up to 9.999.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
     WHERE constraint_schema = 'public' AND constraint_name = 'ai_extractions_overall_confidence_range'
  ) THEN
    ALTER TABLE ai_extractions
      ADD CONSTRAINT ai_extractions_overall_confidence_range
      CHECK (overall_confidence IS NULL OR (overall_confidence >= 0 AND overall_confidence <= 1));
  END IF;
END $$;

-- A row cannot supersede itself.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
     WHERE constraint_schema = 'public' AND constraint_name = 'ai_extractions_no_self_supersede'
  ) THEN
    ALTER TABLE ai_extractions
      ADD CONSTRAINT ai_extractions_no_self_supersede
      CHECK (superseded_by_id IS NULL OR superseded_by_id <> id);
  END IF;
END $$;

-- ── 4. Extend upsert RPC to also write raw_content into the new table ──────
-- The existing upsert_extraction_versioned function inserts into ai_extractions
-- but the column is gone now. Drop and recreate without raw_content; raw_content
-- is written by the edge function in a second statement (same transaction is
-- impossible across RPCs, so this is best-effort but acceptable since PII
-- retention is non-critical to the workflow).
DROP FUNCTION IF EXISTS upsert_extraction_versioned(TEXT, TEXT, TEXT, JSONB, TEXT, NUMERIC, BOOLEAN);

CREATE OR REPLACE FUNCTION upsert_extraction_versioned(
  p_customer_id          TEXT,
  p_source_type          TEXT,
  p_raw_content          TEXT,         -- still in signature for caller compat; written to side table
  p_payload              JSONB,
  p_model_used           TEXT,
  p_overall_confidence   NUMERIC,
  p_is_ready_for_invoicing BOOLEAN
)
RETURNS TABLE (
  new_extraction_id        UUID,
  assigned_version_number  INTEGER,
  superseded_ids           UUID[],
  prior_payload            JSONB,
  is_revision              BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_po_id          TEXT;
  v_lock_key       BIGINT;
  v_next_version   INTEGER := 1;
  v_supersede      UUID[]  := ARRAY[]::UUID[];
  v_prior_payload  JSONB   := NULL;
  v_new_id         UUID;
  v_is_revision    BOOLEAN := false;
  r                RECORD;
BEGIN
  v_po_id := p_payload->'metadata'->>'po_id';
  IF v_po_id IS NULL OR v_po_id = '' THEN
    RAISE EXCEPTION 'payload.metadata.po_id is required';
  END IF;

  v_lock_key := hashtextextended(p_customer_id || '|' || v_po_id, 0);
  PERFORM pg_advisory_xact_lock(v_lock_key);

  FOR r IN
    SELECT id, version_number, payload
      FROM ai_extractions
     WHERE kind = 'purchase_order'
       AND customer_id = p_customer_id
       AND is_current_version = true
       AND payload->'metadata'->>'po_id' = v_po_id
     ORDER BY version_number DESC
     FOR UPDATE
  LOOP
    v_is_revision := true;
    IF r.version_number + 1 > v_next_version THEN
      v_next_version := r.version_number + 1;
      IF v_prior_payload IS NULL THEN
        v_prior_payload := r.payload;
      END IF;
    END IF;
    v_supersede := v_supersede || r.id;
  END LOOP;

  IF cardinality(v_supersede) > 0 THEN
    UPDATE ai_extractions
       SET is_current_version = false
     WHERE id = ANY(v_supersede);
  END IF;

  INSERT INTO ai_extractions (
    kind, customer_id, source_type, payload,
    model_used, overall_confidence, is_ready_for_invoicing,
    version_number, is_current_version
  ) VALUES (
    'purchase_order', p_customer_id, p_source_type, p_payload,
    p_model_used, p_overall_confidence, p_is_ready_for_invoicing,
    v_next_version, true
  )
  RETURNING id INTO v_new_id;

  IF p_raw_content IS NOT NULL THEN
    INSERT INTO ai_extraction_raw_content (extraction_id, raw_content, byte_length)
    VALUES (v_new_id, p_raw_content, length(p_raw_content));
  END IF;

  IF cardinality(v_supersede) > 0 THEN
    UPDATE ai_extractions
       SET superseded_by_id = v_new_id
     WHERE id = ANY(v_supersede);
  END IF;

  RETURN QUERY
    SELECT v_new_id, v_next_version, v_supersede, v_prior_payload, v_is_revision;
END;
$$;

GRANT EXECUTE ON FUNCTION upsert_extraction_versioned(TEXT, TEXT, TEXT, JSONB, TEXT, NUMERIC, BOOLEAN)
  TO service_role;
