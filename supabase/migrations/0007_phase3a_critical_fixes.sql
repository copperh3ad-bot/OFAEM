-- 0007_phase3a_critical_fixes.sql
-- Phase 3a critical fixes:
--   1. UNIQUE partial index preventing two is_current_version=true rows per (customer_id, po_id)
--   2. Atomic upsert_extraction_versioned() RPC: insert + supersede prior under advisory xact lock
--   3. customer_email_map table for explicit sender→customer overrides
--   4. shared_email_domains table for Gmail/Outlook/etc. so domain-based grouping is rejected
--   5. Search-path hardening on current_user_role() and fn_enforce_proforma_signoff_role()

-- ── 1. Partial unique index ─────────────────────────────────────────────────
-- (Cannot use IF NOT EXISTS for CREATE UNIQUE INDEX with WHERE clause in some
-- Postgres versions — use a guarded DO block instead.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'uniq_current_version_per_po'
  ) THEN
    CREATE UNIQUE INDEX uniq_current_version_per_po
      ON ai_extractions (customer_id, (payload->'metadata'->>'po_id'))
      WHERE is_current_version = true AND kind = 'purchase_order';
  END IF;
END $$;

-- ── 2. Atomic insert + revision supersede ───────────────────────────────────
CREATE OR REPLACE FUNCTION upsert_extraction_versioned(
  p_customer_id          TEXT,
  p_source_type          TEXT,
  p_raw_content          TEXT,
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

  -- Serialize concurrent ingests for the same (customer, po_id) pair
  v_lock_key := hashtextextended(p_customer_id || '|' || v_po_id, 0);
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Find prior current versions (lock them so subsequent updates are clean)
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

  -- Clear is_current_version on priors FIRST so the unique partial index
  -- does not conflict when we insert the new current row.
  IF cardinality(v_supersede) > 0 THEN
    UPDATE ai_extractions
       SET is_current_version = false
     WHERE id = ANY(v_supersede);
  END IF;

  -- Insert the new row as the current version
  INSERT INTO ai_extractions (
    kind, customer_id, source_type, raw_content, payload,
    model_used, overall_confidence, is_ready_for_invoicing,
    version_number, is_current_version
  ) VALUES (
    'purchase_order', p_customer_id, p_source_type, p_raw_content, p_payload,
    p_model_used, p_overall_confidence, p_is_ready_for_invoicing,
    v_next_version, true
  )
  RETURNING id INTO v_new_id;

  -- Now set superseded_by_id on the prior rows
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

-- ── 3. customer_email_map (explicit sender → canonical customer) ────────────
CREATE TABLE IF NOT EXISTS customer_email_map (
  id            BIGSERIAL PRIMARY KEY,
  email_pattern TEXT NOT NULL,
  pattern_type  TEXT NOT NULL CHECK (pattern_type IN ('exact','domain')),
  customer_id   TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE (email_pattern, pattern_type)
);
CREATE INDEX IF NOT EXISTS idx_customer_email_map_pattern
  ON customer_email_map (pattern_type, email_pattern);

ALTER TABLE customer_email_map ENABLE ROW LEVEL SECURITY;

CREATE POLICY customer_email_map_read_team ON customer_email_map
  FOR SELECT TO authenticated
  USING (current_user_role() IN ('Owner','Manager','Merchandiser','Viewer'));

CREATE POLICY customer_email_map_write_owner_manager ON customer_email_map
  FOR ALL TO authenticated
  USING (current_user_role() IN ('Owner','Manager'))
  WITH CHECK (current_user_role() IN ('Owner','Manager'));

CREATE POLICY customer_email_map_service ON customer_email_map
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 4. shared_email_domains (block domain-based grouping for these) ─────────
CREATE TABLE IF NOT EXISTS shared_email_domains (
  domain      TEXT PRIMARY KEY,
  created_at  TIMESTAMPTZ DEFAULT now()
);

INSERT INTO shared_email_domains (domain) VALUES
  ('gmail.com'), ('googlemail.com'),
  ('outlook.com'), ('hotmail.com'), ('live.com'), ('msn.com'),
  ('yahoo.com'), ('yahoo.co.uk'), ('ymail.com'),
  ('aol.com'), ('icloud.com'), ('me.com'),
  ('protonmail.com'), ('proton.me'),
  ('mail.com'), ('gmx.com'), ('zoho.com'),
  ('qq.com'), ('163.com'), ('126.com')
ON CONFLICT DO NOTHING;

ALTER TABLE shared_email_domains ENABLE ROW LEVEL SECURITY;

CREATE POLICY shared_domains_read_authed ON shared_email_domains
  FOR SELECT TO authenticated USING (true);

CREATE POLICY shared_domains_write_owner ON shared_email_domains
  FOR ALL TO authenticated
  USING (current_user_role() = 'Owner')
  WITH CHECK (current_user_role() = 'Owner');

CREATE POLICY shared_domains_service ON shared_email_domains
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 5. Resolve sender to customer_id (RPC) ──────────────────────────────────
CREATE OR REPLACE FUNCTION resolve_customer_for_sender(p_from_address TEXT)
RETURNS TABLE (customer_id TEXT, resolution_source TEXT, is_shared_domain BOOLEAN)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email      TEXT;
  v_domain     TEXT;
  v_mapped     TEXT;
  v_shared     BOOLEAN := false;
BEGIN
  v_email := lower(trim(p_from_address));
  IF v_email = '' OR v_email NOT LIKE '%@%' THEN
    RETURN QUERY SELECT 'UNKNOWN_BUYER'::TEXT, 'invalid_address'::TEXT, false;
    RETURN;
  END IF;

  v_domain := split_part(v_email, '@', 2);

  -- 1) Exact email mapping wins
  SELECT m.customer_id INTO v_mapped
    FROM customer_email_map m
   WHERE m.pattern_type = 'exact' AND lower(m.email_pattern) = v_email
   LIMIT 1;
  IF v_mapped IS NOT NULL THEN
    RETURN QUERY SELECT v_mapped, 'exact_mapping'::TEXT, false;
    RETURN;
  END IF;

  -- 2) Shared domain → isolate by full email (each sender = own customer_id)
  IF EXISTS (SELECT 1 FROM shared_email_domains s WHERE s.domain = v_domain) THEN
    RETURN QUERY SELECT
      upper(v_email),
      'shared_domain_isolated'::TEXT,
      true;
    RETURN;
  END IF;

  -- 3) Domain mapping
  SELECT m.customer_id INTO v_mapped
    FROM customer_email_map m
   WHERE m.pattern_type = 'domain' AND lower(m.email_pattern) = v_domain
   LIMIT 1;
  IF v_mapped IS NOT NULL THEN
    RETURN QUERY SELECT v_mapped, 'domain_mapping'::TEXT, false;
    RETURN;
  END IF;

  -- 4) Default: corporate domain → use uppercased domain as customer_id
  RETURN QUERY SELECT upper(v_domain), 'domain_default'::TEXT, false;
END;
$$;

GRANT EXECUTE ON FUNCTION resolve_customer_for_sender(TEXT)
  TO authenticated, service_role;

-- ── 6. Search-path hardening on existing SECURITY DEFINER functions ─────────
ALTER FUNCTION current_user_role() SET search_path = public;
ALTER FUNCTION fn_enforce_proforma_signoff_role() SET search_path = public;
