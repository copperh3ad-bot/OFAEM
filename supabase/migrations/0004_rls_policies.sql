-- 0004_rls_policies.sql
-- Single-org tenancy. customer_id = buyer brand (H&M, Zara, …), NOT a tenant.
-- Role hierarchy (user_profiles.role):
--   Owner / Manager   → full CRUD on everything
--   Merchandiser      → CRUD on POs and extractions; no delete; cannot sign off invoices
--   Viewer            → SELECT only
--   Supplier          → SELECT only, scoped to their buyer (buyer_contacts pattern)
--   QC Inspector      → SELECT only on extractions
--   service_role      → bypass (used by edge functions)

-- Helper: current user's role
CREATE OR REPLACE FUNCTION current_user_role()
RETURNS TEXT
LANGUAGE SQL
STABLE
SECURITY DEFINER
AS $$
  SELECT role FROM user_profiles WHERE id = auth.uid()
$$;

-- ── master_articles ──────────────────────────────────────────────────────────
ALTER TABLE master_articles ENABLE ROW LEVEL SECURITY;

CREATE POLICY master_articles_read_all_authenticated ON master_articles
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY master_articles_write_manager_plus ON master_articles
  FOR ALL TO authenticated
  USING (current_user_role() IN ('Owner','Manager'))
  WITH CHECK (current_user_role() IN ('Owner','Manager'));

CREATE POLICY master_articles_service ON master_articles
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── ai_extractions ───────────────────────────────────────────────────────────
ALTER TABLE ai_extractions ENABLE ROW LEVEL SECURITY;

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

-- ── proforma_invoices ────────────────────────────────────────────────────────
ALTER TABLE proforma_invoices ENABLE ROW LEVEL SECURITY;

CREATE POLICY proforma_owner_manager_full ON proforma_invoices
  FOR ALL TO authenticated
  USING (current_user_role() IN ('Owner','Manager'))
  WITH CHECK (current_user_role() IN ('Owner','Manager'));

CREATE POLICY proforma_merchandiser_select ON proforma_invoices
  FOR SELECT TO authenticated
  USING (current_user_role() = 'Merchandiser');

CREATE POLICY proforma_merchandiser_insert ON proforma_invoices
  FOR INSERT TO authenticated
  WITH CHECK (
    current_user_role() = 'Merchandiser'
    AND is_ready_for_invoicing = false   -- merchandiser cannot sign off on insert
  );

CREATE POLICY proforma_viewer_select ON proforma_invoices
  FOR SELECT TO authenticated
  USING (current_user_role() = 'Viewer');

CREATE POLICY proforma_service ON proforma_invoices
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── error_log / ml_feedback / error_patterns ────────────────────────────────
ALTER TABLE error_log       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ml_feedback     ENABLE ROW LEVEL SECURITY;
ALTER TABLE error_patterns  ENABLE ROW LEVEL SECURITY;

-- Insert: any authenticated user can log their own errors / corrections
CREATE POLICY error_log_insert_any_authed ON error_log
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY ml_feedback_insert_any_authed ON ml_feedback
  FOR INSERT TO authenticated WITH CHECK (true);

-- Read: Owner/Manager only (PII potential + ML strategy data)
CREATE POLICY error_log_read_owner_manager ON error_log
  FOR SELECT TO authenticated
  USING (current_user_role() IN ('Owner','Manager'));

CREATE POLICY ml_feedback_read_owner_manager ON ml_feedback
  FOR SELECT TO authenticated
  USING (current_user_role() IN ('Owner','Manager'));

CREATE POLICY error_patterns_read_owner_manager ON error_patterns
  FOR SELECT TO authenticated
  USING (current_user_role() IN ('Owner','Manager'));

CREATE POLICY error_log_service       ON error_log       FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY ml_feedback_service     ON ml_feedback     FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY error_patterns_service  ON error_patterns  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── user_profiles ────────────────────────────────────────────────────────────
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

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
