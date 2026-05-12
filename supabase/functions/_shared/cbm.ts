/**
 * CBM (Cubic Meter) calculation engine.
 *
 * Three-tier dimension resolution:
 *   EXPLICIT      — dimensions present on the PO line item (confidence 0.99)
 *   SKU_LOOKUP    — dimensions from master_articles.standard_dimensions (0.85)
 *   HEURISTIC     — per-unit volume keyed on (category, unit) (0.60)
 *
 * Critical correctness note: heuristic volumes are PER-UNIT-OF-QUANTITY,
 * not per-piece-of-finished-product. A 500m fabric line uses fabric/m volume,
 * not bolt volume — avoiding the qty × L × W × H double-count.
 */

export type ResolutionTier = "EXPLICIT" | "SKU_LOOKUP" | "HEURISTIC";

export interface Dimensions {
  length_m?: number;
  width_m?: number;
  height_m?: number;
  volume_per_unit?: number;
  resolution_tier: ResolutionTier;
  confidence: number;
}

export interface LineItem {
  line_no: number;
  sku: string;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  dimensions?: Dimensions | null;
  cbm?: number | null;
  cbm_calculated?: boolean;
  sku_confidence?: number;
  requires_review?: boolean;
  review_reason?: string | null;
}

export interface MasterArticle {
  sku: string;
  category?: string;
  unit?: string;
  standard_dimensions?: {
    length_m?: number;
    width_m?: number;
    height_m?: number;
    volume_per_unit?: number;
  };
}

const HEURISTIC_VOLUMES_M3: Record<string, number> = {
  "fabric/METER":  0.0007,
  "fabric/YARD":   0.00064,
  "fabric/ROLL":   0.105,
  "fabric/BOLT":   0.105,
  "yarn/KG":       0.002,
  "garment/PIECE": 0.012,
  "garment/BOX":   0.05,
  "trim/LITER":    0.0011,
  "trim/PIECE":    0.005,
};

const HEURISTIC_FALLBACK_M3 = 0.01;

function classifyCategory(description: string): string {
  const d = description.toLowerCase();
  if (/(fabric|cotton|polyester|linen|denim|silk|wool)/.test(d)) return "fabric";
  if (/yarn|thread/.test(d)) return "yarn";
  if (/(shirt|trouser|garment|tee|t-shirt|dress|jacket|hoodie)/.test(d)) return "garment";
  if (/(button|zipper|label|trim|tag|chemical|dye|bleach)/.test(d)) return "trim";
  return "unknown";
}

function isValidDim(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 && n < 10;
}

function dimsFromExplicit(d: Partial<Dimensions> | null | undefined): Dimensions | null {
  if (!d) return null;
  if (isValidDim(d.length_m) && isValidDim(d.width_m) && isValidDim(d.height_m)) {
    return {
      length_m: d.length_m, width_m: d.width_m, height_m: d.height_m,
      volume_per_unit: d.length_m * d.width_m * d.height_m,
      resolution_tier: "EXPLICIT", confidence: 0.99,
    };
  }
  if (isValidDim(d.volume_per_unit)) {
    return { volume_per_unit: d.volume_per_unit, resolution_tier: "EXPLICIT", confidence: 0.99 };
  }
  return null;
}

function dimsFromLookup(article: MasterArticle | undefined): Dimensions | null {
  const sd = article?.standard_dimensions;
  if (!sd) return null;
  if (isValidDim(sd.length_m) && isValidDim(sd.width_m) && isValidDim(sd.height_m)) {
    return {
      length_m: sd.length_m, width_m: sd.width_m, height_m: sd.height_m,
      volume_per_unit: sd.length_m * sd.width_m * sd.height_m,
      resolution_tier: "SKU_LOOKUP", confidence: 0.85,
    };
  }
  if (isValidDim(sd.volume_per_unit)) {
    return { volume_per_unit: sd.volume_per_unit, resolution_tier: "SKU_LOOKUP", confidence: 0.85 };
  }
  return null;
}

function dimsFromHeuristic(description: string, unit: string): Dimensions {
  const category = classifyCategory(description);
  const key = `${category}/${unit.toUpperCase()}`;
  const v = HEURISTIC_VOLUMES_M3[key] ?? HEURISTIC_FALLBACK_M3;
  return { volume_per_unit: v, resolution_tier: "HEURISTIC", confidence: 0.60 };
}

export function resolveDimensions(
  item: LineItem,
  masterLookup: Map<string, MasterArticle>,
): Dimensions {
  return (
    dimsFromExplicit(item.dimensions ?? null)
    ?? dimsFromLookup(masterLookup.get(item.sku))
    ?? dimsFromHeuristic(item.description, item.unit)
  );
}

export function calculateCBM(
  items: LineItem[],
  masterLookup: Map<string, MasterArticle> = new Map(),
): LineItem[] {
  return items.map((item) => {
    const dims = resolveDimensions(item, masterLookup);
    const volume = dims.volume_per_unit ?? 0;
    const cbm = Math.round(item.quantity * volume * 10000) / 10000;
    return { ...item, dimensions: dims, cbm, cbm_calculated: true };
  });
}
