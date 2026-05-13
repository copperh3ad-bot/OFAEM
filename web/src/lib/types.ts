export type WorkflowStage =
  | "PO_INTAKE_VALIDATION"
  | "LOGISTICAL_PLANNING"
  | "SCHEDULING_DOCUMENTATION"
  | "QUALITY_COMPLIANCE"
  | "CRISIS_MANAGEMENT"
  | "READY_SHIPMENT";

export interface LineItem {
  line_no: number;
  sku: string;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  cbm?: number | null;
  cbm_calculated?: boolean;
  sku_confidence?: number;
  quantity_confidence?: number;
  unit_confidence?: number;
  price_confidence?: number;
  requires_review?: boolean;
  review_reason?: string | null;
  dimensions?: {
    length_m?: number;
    width_m?: number;
    height_m?: number;
    volume_per_unit?: number;
    resolution_tier?: "EXPLICIT" | "SKU_LOOKUP" | "HEURISTIC";
    confidence?: number;
  } | null;
}

export interface PONormalized {
  metadata: {
    po_id: string;
    po_date: string | null;
    customer_id: string;
    currency: string;
    source_document_type: string;
    payment_method: string | null;
    delivery_destination: string | null;
    consignee: string | null;
    extracted_at: string;
    parsed_by_version: string;
  };
  line_items: LineItem[];
  flags: {
    is_ready_for_invoicing: boolean;
    requires_review: boolean;
    cbm_calculated?: boolean;
  };
  totals: {
    total_items: number;
    total_value: number;
    total_cbm: number;
  };
  validation_summary: {
    total_errors: number;
    total_warnings: number;
    items_requiring_review: number;
    passed: boolean;
  };
}

export interface AIExtraction {
  id: string;
  kind: string;
  customer_id: string;
  source_type: string;
  payload: PONormalized;
  model_used: string | null;
  overall_confidence: number | null;
  is_ready_for_invoicing: boolean;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  version_number: number;
  is_current_version: boolean;
  superseded_by_id: string | null;
  revision_diff: Record<string, unknown> | null;
}

export interface WorkflowStateRow {
  extraction_id: string;
  customer_id: string;
  po_id: string;
  version_number: number;
  is_ready_for_invoicing: boolean;
  requires_review: boolean;
  shipping_method: string | null;
  estimated_transit_days: number | null;
  shipping_date: string | null;
  scheduled_delivery_date: string | null;
  schedule_is_tight: boolean | null;
  passed_certification: boolean | null;
  defect_rate_percentage: number | null;
  active_crisis_count: number;
  highest_active_severity: string;
  current_stage: WorkflowStage;
}

export interface CrisisAlert {
  id: string;
  extraction_id: string;
  crisis_type: string;
  severity: "low" | "medium" | "high" | "critical";
  details: string;
  status: "active" | "mitigating" | "resolved" | "escalated";
  mitigation_plan: Record<string, unknown> | null;
  raised_at: string;
  resolved_at: string | null;
  resolution_notes: string | null;
}

export type UserRole =
  | "Owner" | "Manager" | "Merchandiser" | "Viewer" | "Supplier" | "QC Inspector";

export interface ProformaInvoice {
  id: string;
  extraction_id: string;
  po_id: string;
  customer_id: string;
  file_path: string;
  checksum: string;
  total_value: number | null;
  total_cbm: number | null;
  is_ready_for_invoicing: boolean;
  signed_off_by: string | null;
  signed_off_at: string | null;
  generated_by: string | null;
  generated_at: string;
}
