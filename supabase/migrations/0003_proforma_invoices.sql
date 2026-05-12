-- 0003_proforma_invoices.sql
-- Persisted proforma invoice records; HTML files live in Storage bucket "proforma-invoices".

CREATE TABLE IF NOT EXISTS proforma_invoices (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  extraction_id          UUID NOT NULL REFERENCES ai_extractions(id) ON DELETE CASCADE,
  po_id                  TEXT NOT NULL,
  customer_id            TEXT NOT NULL,
  file_path              TEXT NOT NULL,
  checksum               TEXT NOT NULL,
  total_value            NUMERIC(14,2),
  total_cbm              NUMERIC(10,4),
  is_ready_for_invoicing BOOLEAN DEFAULT false,
  signed_off_by          UUID REFERENCES auth.users(id),
  signed_off_at          TIMESTAMPTZ,
  generated_by           UUID REFERENCES auth.users(id),
  generated_at           TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_proforma_invoices_po          ON proforma_invoices(po_id);
CREATE INDEX IF NOT EXISTS idx_proforma_invoices_customer    ON proforma_invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_proforma_invoices_extraction  ON proforma_invoices(extraction_id);
CREATE INDEX IF NOT EXISTS idx_proforma_invoices_ready
  ON proforma_invoices(is_ready_for_invoicing, generated_at DESC);

-- Sign-off gate: only Owner/Manager may flip is_ready_for_invoicing → true.
-- service_role bypasses this (edge functions create with false; humans sign off).
CREATE OR REPLACE FUNCTION fn_enforce_proforma_signoff_role()
RETURNS TRIGGER AS $$
DECLARE
  _role TEXT;
BEGIN
  IF NEW.is_ready_for_invoicing = true
     AND (OLD.is_ready_for_invoicing IS DISTINCT FROM true) THEN

    -- service_role bypass (no auth.uid())
    IF auth.uid() IS NULL THEN
      RETURN NEW;
    END IF;

    SELECT role INTO _role FROM user_profiles WHERE id = auth.uid();
    IF _role NOT IN ('Owner','Manager') THEN
      RAISE EXCEPTION 'Only Owner or Manager can sign off a proforma invoice (got role=%)', COALESCE(_role,'<none>');
    END IF;

    NEW.signed_off_by := auth.uid();
    NEW.signed_off_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_enforce_proforma_signoff ON proforma_invoices;
CREATE TRIGGER trg_enforce_proforma_signoff
  BEFORE UPDATE ON proforma_invoices
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_proforma_signoff_role();
