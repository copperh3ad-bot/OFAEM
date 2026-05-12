import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { tokenSetRatio, bestMatch } from "../../supabase/functions/_shared/fuzzy.ts";

Deno.test("identical strings score 100", () => {
  assertEquals(tokenSetRatio("FAB-001", "FAB-001"), 100);
});

Deno.test("token-set ignores order and duplicates", () => {
  const s = tokenSetRatio("cotton 58 inch checkered", "checkered cotton 58 inch");
  assertEquals(s, 100);
});

Deno.test("near-miss SKU scores high enough to match", () => {
  const s = tokenSetRatio("FAB001CHK", "FAB-001-CHK");
  assert(s >= 70, `expected >=70 got ${s}`);
});

Deno.test("unrelated strings score below threshold", () => {
  const s = tokenSetRatio("widget", "elephant chair");
  assert(s < 50);
});

Deno.test("bestMatch returns master row above threshold", () => {
  const master = [
    { sku: "FAB-001-CHK", description: "Checkered Cotton 58 inches" },
    { sku: "GAR-001-TSH", description: "T-Shirt Adult Large" },
  ];
  const m = bestMatch("FAB001CHK", "cotton checkered fabric", master);
  assertEquals(m?.sku, "FAB-001-CHK");
});

Deno.test("bestMatch returns null below threshold", () => {
  const master = [{ sku: "FAB-001-CHK", description: "Checkered Cotton 58 inches" }];
  const m = bestMatch("xyzabc", "unrelated random text", master);
  assertEquals(m, null);
});
