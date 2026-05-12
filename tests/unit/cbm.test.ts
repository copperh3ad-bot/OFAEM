import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { calculateCBM, type LineItem, type MasterArticle } from "../../supabase/functions/_shared/cbm.ts";

Deno.test("EXPLICIT dimensions are preferred over lookup and heuristic", () => {
  const items: LineItem[] = [{
    line_no: 1, sku: "X1", description: "fabric",
    quantity: 10, unit: "PIECE", unit_price: 1,
    dimensions: { length_m: 2, width_m: 2, height_m: 2, resolution_tier: "EXPLICIT", confidence: 0.99 },
  }];
  const master = new Map<string, MasterArticle>([["X1", {
    sku: "X1", standard_dimensions: { length_m: 1, width_m: 1, height_m: 1 },
  }]]);
  const out = calculateCBM(items, master);
  assertEquals(out[0].dimensions?.resolution_tier, "EXPLICIT");
  assertEquals(out[0].cbm, 80);
});

Deno.test("SKU_LOOKUP used when no explicit dims but master has them", () => {
  const items: LineItem[] = [{
    line_no: 1, sku: "Y1", description: "yarn",
    quantity: 5, unit: "KG", unit_price: 1, dimensions: null,
  }];
  const master = new Map<string, MasterArticle>([["Y1", {
    sku: "Y1", standard_dimensions: { length_m: 0.5, width_m: 0.5, height_m: 0.5 },
  }]]);
  const out = calculateCBM(items, master);
  assertEquals(out[0].dimensions?.resolution_tier, "SKU_LOOKUP");
  assertEquals(out[0].cbm, 0.625);
});

Deno.test("HEURISTIC for fabric/METER uses per-meter volume (no double-count)", () => {
  const items: LineItem[] = [{
    line_no: 1, sku: "F1", description: "cotton fabric striped",
    quantity: 500, unit: "METER", unit_price: 2.5,
  }];
  const out = calculateCBM(items);
  assertEquals(out[0].dimensions?.resolution_tier, "HEURISTIC");
  // 500m × 0.0007 m³/m = 0.35 m³ — sane for half a container's worth of fabric
  assert(out[0].cbm! > 0.3 && out[0].cbm! < 0.4, `expected ~0.35 m³ got ${out[0].cbm}`);
});

Deno.test("HEURISTIC for yarn/KG yields ~2L per kg (not 125L)", () => {
  const items: LineItem[] = [{
    line_no: 1, sku: "Y2", description: "cotton yarn cone",
    quantity: 100, unit: "KG", unit_price: 8,
  }];
  const out = calculateCBM(items);
  assertEquals(out[0].dimensions?.resolution_tier, "HEURISTIC");
  // 100kg × 0.002 m³ = 0.2 m³
  assert(out[0].cbm! > 0.15 && out[0].cbm! < 0.25, `expected ~0.2 m³ got ${out[0].cbm}`);
});

Deno.test("HEURISTIC for garment/PIECE uses per-piece box volume", () => {
  const items: LineItem[] = [{
    line_no: 1, sku: "G1", description: "t-shirt adult large",
    quantity: 2000, unit: "PIECE", unit_price: 1.5,
  }];
  const out = calculateCBM(items);
  assertEquals(out[0].dimensions?.resolution_tier, "HEURISTIC");
  // 2000 × 0.012 = 24 m³
  assert(out[0].cbm! > 23 && out[0].cbm! < 25);
});

Deno.test("cbm_calculated flag is always true after enrichment", () => {
  const items: LineItem[] = [{
    line_no: 1, sku: "Z1", description: "unknown widget",
    quantity: 1, unit: "PIECE", unit_price: 1,
  }];
  const out = calculateCBM(items);
  assertEquals(out[0].cbm_calculated, true);
});
