// Seed master_articles for fuzzy matching tests.
// Run: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... deno run --allow-env --allow-net scripts/seed_master_articles.ts

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const URL = Deno.env.get("SUPABASE_URL");
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!URL || !KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  Deno.exit(1);
}
const supabase = createClient(URL, KEY);

const ARTICLES = [
  { sku: "FAB-001-CHK", description: "Checkered Cotton Fabric 58 inches", category: "fabric",  unit: "METER",
    standard_dimensions: null, brand: "Union Mills" },
  { sku: "FAB-002-STR", description: "Striped Polyester Blend 52 inches", category: "fabric",  unit: "METER",
    standard_dimensions: null, brand: "Union Mills" },
  { sku: "YRN-001-CTN", description: "Cotton Yarn 40s Count Natural",     category: "yarn",    unit: "KG",
    standard_dimensions: { length_m: 0.5, width_m: 0.5, height_m: 0.5 }, brand: "Coats" },
  { sku: "GAR-001-TSH", description: "T-Shirt Adult Large White",         category: "garment", unit: "PIECE",
    standard_dimensions: { length_m: 0.4, width_m: 0.3, height_m: 0.1 }, brand: "Union Apparel" },
  { sku: "GAR-002-PNT", description: "Trousers Adult Medium Khaki",       category: "garment", unit: "PIECE",
    standard_dimensions: { length_m: 0.5, width_m: 0.3, height_m: 0.1 }, brand: "Union Apparel" },
  { sku: "TRI-001-BTN", description: "Buttons 4-hole 12mm assorted",      category: "trim",    unit: "PIECE",
    standard_dimensions: { length_m: 0.012, width_m: 0.012, height_m: 0.003 }, brand: "YKK" },
];

const { error } = await supabase.from("master_articles").upsert(ARTICLES, { onConflict: "sku" });
if (error) {
  console.error("Seed failed:", error.message);
  Deno.exit(1);
}
console.log(`Seeded ${ARTICLES.length} master_articles.`);
