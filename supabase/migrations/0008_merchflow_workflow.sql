-- 0008_merchflow_workflow.sql
-- Phase: MerchFlow Coordinator integration
-- Adds the 5-stage textile-export workflow on top of OFAEM extraction:
--   1. PO_INTAKE_VALIDATION   — already covered by ai_extractions (parse-po)
--   2. LOGISTICAL_PLANNING    — new: logistical_plans
--   3. SCHEDULING_DOCUMENTATION — new: production_schedules
--   4. QUALITY_COMPLIANCE     — new: compliance_records
--   5. CRISIS_MANAGEMENT      — new: crisis_alerts (with LLM-generated mitigation)
--
-- workflow_state view rolls all of these up into a single stage indicator per
-- current-version extraction.

-- ── logistical_plans ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS logistical_plans (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  extraction_id              UUID NOT NULL REFERENCES ai_extractions(id) ON DELETE CASCADE,
  shipping_method            TEXT NOT NULL CHECK (shipping_method IN ('AIR','SEA_FCL','SEA_LCL','MIXED','ROAD')),
  estimated_transit_days     INTEGER NOT NULL CHECK (estimated_transit_days > 0),
  estimated_cost             NUMERIC(14,2),
  cost_currency              TEXT,
  consolidation_recommended  BOOLEAN DEFAULT false,
  packaging_requirements     TEXT[],
  rationale                  TEXT,
  total_cbm_used             NUMERIC(10,4),
  total_weight_kg_used       NUMERIC(14,3),
  created_at                 TIMESTAMPTZ DEFAULT now(),
  created_by                 UUID REFERENCES auth.users(id)
);
CREATE INDEX IF NOT EXISTS idx_logistical_plans_extraction ON logistical_plans(extraction_id);

-- ── production_schedules ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS production_schedules (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  extraction_id            UUID NOT NULL REFERENCES ai_extractions(id) ON DELETE CASCADE,
  logistical_plan_id       UUID REFERENCES logistical_plans(id) ON DELETE SET NULL,
  po_date                  DATE,
  production_start         DATE,
  production_end           DATE,
  qa_start                 DATE,
  qa_end                   DATE,
  shipping_date            DATE,
  delivery_date            DATE,
  documentation_required   TEXT[],
  schedule_is_tight        BOOLEAN DEFAULT false,
  buffer_days              INTEGER,
  notes                    TEXT,
  created_at               TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_production_schedules_extraction ON production_schedules(extraction_id);

-- ── compliance_records ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS compliance_records (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  extraction_id            UUID NOT NULL REFERENCES ai_extractions(id) ON DELETE CASCADE,
  inspection_date          TIMESTAMPTZ DEFAULT now(),
  defect_rate_percentage   NUMERIC(5,2) CHECK (defect_rate_percentage BETWEEN 0 AND 100),
  passed_certification     BOOLEAN NOT NULL,
  certificate_types        TEXT[],
  notes                    TEXT,
  inspected_by             UUID REFERENCES auth.users(id),
  approved_by              UUID REFERENCES auth.users(id),
  created_at               TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_compliance_extraction ON compliance_records(extraction_id, inspection_date DESC);

-- ── crisis_alerts ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crisis_alerts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  extraction_id       UUID NOT NULL REFERENCES ai_extractions(id) ON DELETE CASCADE,
  crisis_type         TEXT NOT NULL CHECK (crisis_type IN
                        ('production_delay','quality_issue','logistics_problem',
                         'payment_issue','compliance_failure','customs_hold','other')),
  severity            TEXT NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  details             TEXT NOT NULL,
  mitigation_plan     JSONB,
  mitigation_model    TEXT,
  status              TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','mitigating','resolved','escalated')),
  raised_by           UUID REFERENCES auth.users(id),
  resolved_by         UUID REFERENCES auth.users(id),
  resolution_notes    TEXT,
  raised_at           TIMESTAMPTZ DEFAULT now(),
  resolved_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_crisis_alerts_extraction ON crisis_alerts(extraction_id, status);
CREATE INDEX IF NOT EXISTS idx_crisis_alerts_active ON crisis_alerts(severity, raised_at DESC)
  WHERE status IN ('active','mitigating');

-- ── workflow_state view ─────────────────────────────────────────────────────
-- Maps every current-version PO to its current stage by joining all four
-- workflow tables. The CASE ladder picks the highest-numbered stage reached.
CREATE OR REPLACE VIEW workflow_state AS
SELECT
  ae.id                          AS extraction_id,
  ae.customer_id,
  ae.payload->'metadata'->>'po_id' AS po_id,
  ae.version_number,
  ae.is_ready_for_invoicing,
  (ae.payload->'flags'->>'requires_review')::boolean AS requires_review,
  lp.shipping_method,
  lp.estimated_transit_days,
  ps.shipping_date,
  ps.delivery_date              AS scheduled_delivery_date,
  ps.schedule_is_tight,
  latest_compliance.passed_certification,
  latest_compliance.defect_rate_percentage,
  COALESCE(active.crisis_count, 0) AS active_crisis_count,
  COALESCE(highest.max_severity, 'none') AS highest_active_severity,
  CASE
    WHEN COALESCE(active.crisis_count, 0) > 0 THEN 'CRISIS_MANAGEMENT'
    WHEN latest_compliance.passed_certification IS TRUE THEN 'READY_SHIPMENT'
    WHEN latest_compliance.id IS NOT NULL THEN 'QUALITY_COMPLIANCE'  -- failed, not yet resolved
    WHEN ps.id IS NOT NULL THEN 'QUALITY_COMPLIANCE'                 -- scheduled, awaiting QA
    WHEN lp.id IS NOT NULL THEN 'SCHEDULING_DOCUMENTATION'
    WHEN ae.is_ready_for_invoicing THEN 'LOGISTICAL_PLANNING'
    ELSE 'PO_INTAKE_VALIDATION'
  END AS current_stage
FROM ai_extractions ae
LEFT JOIN LATERAL (
  SELECT id, shipping_method, estimated_transit_days
    FROM logistical_plans
   WHERE extraction_id = ae.id
   ORDER BY created_at DESC LIMIT 1
) lp ON true
LEFT JOIN LATERAL (
  SELECT id, shipping_date, delivery_date, schedule_is_tight
    FROM production_schedules
   WHERE extraction_id = ae.id
   ORDER BY created_at DESC LIMIT 1
) ps ON true
LEFT JOIN LATERAL (
  SELECT id, passed_certification, defect_rate_percentage
    FROM compliance_records
   WHERE extraction_id = ae.id
   ORDER BY inspection_date DESC LIMIT 1
) latest_compliance ON true
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS crisis_count
    FROM crisis_alerts
   WHERE extraction_id = ae.id AND status NOT IN ('resolved')
) active ON true
LEFT JOIN LATERAL (
  SELECT MAX(severity) AS max_severity   -- TEXT max is alphabetical: critical>medium>low ... order matters
    FROM (
      SELECT CASE severity
               WHEN 'critical' THEN '4_critical'
               WHEN 'high'     THEN '3_high'
               WHEN 'medium'   THEN '2_medium'
               WHEN 'low'      THEN '1_low'
             END AS severity
        FROM crisis_alerts
       WHERE extraction_id = ae.id AND status NOT IN ('resolved')
    ) s
) highest ON true
WHERE ae.kind = 'purchase_order' AND ae.is_current_version = true;

-- ── RLS on the four new tables ──────────────────────────────────────────────

-- logistical_plans: read all team roles; write Owner/Manager/Merchandiser
ALTER TABLE logistical_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY logistical_plans_read ON logistical_plans
  FOR SELECT TO authenticated
  USING (current_user_role() IN ('Owner','Manager','Merchandiser','Viewer','QC Inspector'));
CREATE POLICY logistical_plans_write ON logistical_plans
  FOR ALL TO authenticated
  USING (current_user_role() IN ('Owner','Manager','Merchandiser'))
  WITH CHECK (current_user_role() IN ('Owner','Manager','Merchandiser'));
CREATE POLICY logistical_plans_service ON logistical_plans
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- production_schedules: same pattern
ALTER TABLE production_schedules ENABLE ROW LEVEL SECURITY;
CREATE POLICY production_schedules_read ON production_schedules
  FOR SELECT TO authenticated
  USING (current_user_role() IN ('Owner','Manager','Merchandiser','Viewer','QC Inspector'));
CREATE POLICY production_schedules_write ON production_schedules
  FOR ALL TO authenticated
  USING (current_user_role() IN ('Owner','Manager','Merchandiser'))
  WITH CHECK (current_user_role() IN ('Owner','Manager','Merchandiser'));
CREATE POLICY production_schedules_service ON production_schedules
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- compliance_records: read all; write QC Inspector + Owner/Manager
ALTER TABLE compliance_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY compliance_records_read ON compliance_records
  FOR SELECT TO authenticated
  USING (current_user_role() IN ('Owner','Manager','Merchandiser','Viewer','QC Inspector'));
CREATE POLICY compliance_records_write ON compliance_records
  FOR ALL TO authenticated
  USING (current_user_role() IN ('Owner','Manager','QC Inspector'))
  WITH CHECK (current_user_role() IN ('Owner','Manager','QC Inspector'));
CREATE POLICY compliance_records_service ON compliance_records
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- crisis_alerts: read all; write Owner/Manager/Merchandiser; only Owner/Manager can resolve
ALTER TABLE crisis_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY crisis_alerts_read ON crisis_alerts
  FOR SELECT TO authenticated
  USING (current_user_role() IN ('Owner','Manager','Merchandiser','Viewer','QC Inspector'));
CREATE POLICY crisis_alerts_insert ON crisis_alerts
  FOR INSERT TO authenticated
  WITH CHECK (current_user_role() IN ('Owner','Manager','Merchandiser','QC Inspector'));
CREATE POLICY crisis_alerts_update_resolver ON crisis_alerts
  FOR UPDATE TO authenticated
  USING (current_user_role() IN ('Owner','Manager'))
  WITH CHECK (current_user_role() IN ('Owner','Manager'));
CREATE POLICY crisis_alerts_service ON crisis_alerts
  FOR ALL TO service_role USING (true) WITH CHECK (true);
