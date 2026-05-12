import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { applyReadinessFlags } from "../../supabase/functions/_shared/confidence.ts";
import type { LineItem } from "../../supabase/functions/_shared/cbm.ts";

Deno.test("low sku_confidence flags requires_review", () => {
  const items: LineItem[] = [{
    line_no: 1, sku: "X", description: "x", quantity: 1, unit: "PIECE", unit_price: 1,
    sku_confidence: 0.6,
  }];
  const r = applyReadinessFlags(items, 0);
  assertEquals(r.items[0].requires_review, true);
  assert(r.items[0].review_reason?.includes("low_sku_confidence"));
  assertEquals(r.is_ready_for_invoicing, false);
});

Deno.test("HEURISTIC dimensions trigger review even when sku confidence is high", () => {
  const items: LineItem[] = [{
    line_no: 1, sku: "X", description: "x", quantity: 1, unit: "PIECE", unit_price: 1,
    sku_confidence: 0.99,
    dimensions: { volume_per_unit: 0.01, resolution_tier: "HEURISTIC", confidence: 0.6 },
  }];
  const r = applyReadinessFlags(items, 0);
  assertEquals(r.items[0].requires_review, true);
  assert(r.items[0].review_reason?.includes("estimated_dimensions"));
});

Deno.test("all-green items produce is_ready_for_invoicing=true", () => {
  const items: LineItem[] = [{
    line_no: 1, sku: "X", description: "x", quantity: 1, unit: "PIECE", unit_price: 1,
    sku_confidence: 0.99,
    dimensions: { length_m:1, width_m:1, height_m:1, volume_per_unit:1, resolution_tier: "EXPLICIT", confidence: 0.99 },
  }];
  const r = applyReadinessFlags(items, 0);
  assertEquals(r.is_ready_for_invoicing, true);
  assertEquals(r.items_requiring_review, 0);
});

Deno.test("any validation error blocks readiness", () => {
  const items: LineItem[] = [{
    line_no: 1, sku: "X", description: "x", quantity: 1, unit: "PIECE", unit_price: 1,
    sku_confidence: 0.99,
    dimensions: { length_m:1, width_m:1, height_m:1, resolution_tier: "EXPLICIT", confidence: 0.99 },
  }];
  const r = applyReadinessFlags(items, 1);  // one error
  assertEquals(r.is_ready_for_invoicing, false);
});

Deno.test("empty line_items never produces ready=true", () => {
  const r = applyReadinessFlags([], 0);
  assertEquals(r.is_ready_for_invoicing, false);
});

