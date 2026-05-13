/**
 * Assertion helper for PO extraction fixtures.
 *
 * Each tests/fixtures/pos/expected/<name>.expected.json file describes the
 * invariants the parse-po pipeline must produce for the matching input
 * fixture. This module loads the spec and asserts each rule against the
 * extracted normalized_po, producing a list of violations (empty = pass).
 *
 * See tests/fixtures/pos/expected/README.md for the spec format.
 */

export interface ExpectedSpec {
  fixture: string;
  source_type: "PDF" | "IMAGE" | "EXCEL" | "EMAIL" | "MANUAL";
  raw_email?: boolean;
  file_mime?: string;
  po_id_contains?: string;
  currency?: string;
  payment_method?: string | null;
  line_items_count?: { min?: number; max?: number };
  line_items_must_include_sku_substrings?: string[];
  line_items_must_include_units?: string[];
  totals_total_value_within_pct?: { expected: number; tolerance: number };
  totals_total_cbm_min?: number;
  inline_images_processed_min?: number;
  flags?: { is_ready_for_invoicing?: boolean; requires_review?: boolean };
}

export interface ExtractionResponseShape {
  success?: boolean;
  normalized_po?: {
    metadata?: { po_id?: string; currency?: string; payment_method?: string | null };
    line_items?: Array<{ sku: string; unit: string; quantity: number; unit_price: number }>;
    totals?: { total_value?: number; total_cbm?: number };
    flags?: { is_ready_for_invoicing?: boolean; requires_review?: boolean };
  };
  inline_images_processed?: number;
}

export interface Violation { rule: string; expected: unknown; actual: unknown }

export function compare(spec: ExpectedSpec, actual: ExtractionResponseShape): Violation[] {
  const v: Violation[] = [];
  const md = actual.normalized_po?.metadata ?? {};
  const items = actual.normalized_po?.line_items ?? [];
  const totals = actual.normalized_po?.totals ?? {};
  const flags = actual.normalized_po?.flags ?? {};

  if (spec.po_id_contains && !(md.po_id ?? "").includes(spec.po_id_contains)) {
    v.push({ rule: "po_id_contains", expected: spec.po_id_contains, actual: md.po_id });
  }
  if (spec.currency && md.currency !== spec.currency) {
    v.push({ rule: "currency", expected: spec.currency, actual: md.currency });
  }
  if (spec.payment_method !== undefined && md.payment_method !== spec.payment_method) {
    v.push({ rule: "payment_method", expected: spec.payment_method, actual: md.payment_method });
  }

  if (spec.line_items_count) {
    const n = items.length;
    if (spec.line_items_count.min !== undefined && n < spec.line_items_count.min) {
      v.push({ rule: "line_items_count.min", expected: spec.line_items_count.min, actual: n });
    }
    if (spec.line_items_count.max !== undefined && n > spec.line_items_count.max) {
      v.push({ rule: "line_items_count.max", expected: spec.line_items_count.max, actual: n });
    }
  }

  if (spec.line_items_must_include_sku_substrings) {
    const skus = items.map((i) => (i.sku ?? "").toUpperCase());
    for (const need of spec.line_items_must_include_sku_substrings) {
      if (!skus.some((s) => s.includes(need.toUpperCase()))) {
        v.push({ rule: "line_items_must_include_sku_substring", expected: need, actual: skus });
      }
    }
  }

  if (spec.line_items_must_include_units) {
    const units = items.map((i) => (i.unit ?? "").toUpperCase());
    for (const need of spec.line_items_must_include_units) {
      if (!units.includes(need.toUpperCase())) {
        v.push({ rule: "line_items_must_include_unit", expected: need, actual: units });
      }
    }
  }

  if (spec.totals_total_value_within_pct) {
    const { expected, tolerance } = spec.totals_total_value_within_pct;
    const actualVal = totals.total_value ?? 0;
    const diff = Math.abs(actualVal - expected);
    const allowed = expected * tolerance;
    if (diff > allowed) {
      v.push({
        rule: "totals_total_value_within_pct",
        expected: `${expected} ± ${(tolerance * 100).toFixed(1)}%`,
        actual: actualVal,
      });
    }
  }

  if (spec.totals_total_cbm_min !== undefined) {
    const actualCbm = totals.total_cbm ?? 0;
    if (actualCbm < spec.totals_total_cbm_min) {
      v.push({ rule: "totals_total_cbm_min", expected: spec.totals_total_cbm_min, actual: actualCbm });
    }
  }

  if (spec.inline_images_processed_min !== undefined) {
    const n = actual.inline_images_processed ?? 0;
    if (n < spec.inline_images_processed_min) {
      v.push({ rule: "inline_images_processed_min", expected: spec.inline_images_processed_min, actual: n });
    }
  }

  if (spec.flags) {
    if (spec.flags.is_ready_for_invoicing !== undefined
        && flags.is_ready_for_invoicing !== spec.flags.is_ready_for_invoicing) {
      v.push({
        rule: "flags.is_ready_for_invoicing",
        expected: spec.flags.is_ready_for_invoicing,
        actual: flags.is_ready_for_invoicing,
      });
    }
    if (spec.flags.requires_review !== undefined
        && flags.requires_review !== spec.flags.requires_review) {
      v.push({
        rule: "flags.requires_review",
        expected: spec.flags.requires_review,
        actual: flags.requires_review,
      });
    }
  }

  return v;
}

export function formatViolations(v: Violation[]): string {
  return v.map((x) => `  - ${x.rule}: expected ${JSON.stringify(x.expected)}, got ${JSON.stringify(x.actual)}`).join("\n");
}
