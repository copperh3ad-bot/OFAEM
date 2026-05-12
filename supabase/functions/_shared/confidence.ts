/**
 * Confidence rollup: per-line-item flags + overall is_ready_for_invoicing gate.
 *
 * Thresholds align with fuzzy match scoring:
 *   sku_confidence < 0.80   → review (fuzzy match below ~78/100)
 *   field_confidence < 0.75 → review
 *   dimensions HEURISTIC    → review (estimated volume)
 */

import type { LineItem } from "./cbm.ts";

export const SKU_CONFIDENCE_REVIEW_THRESHOLD = 0.80;
export const FIELD_CONFIDENCE_REVIEW_THRESHOLD = 0.75;

export interface ReadinessResult {
  items: LineItem[];
  items_requiring_review: number;
  is_ready_for_invoicing: boolean;
  requires_review: boolean;
}

export function applyReadinessFlags(
  items: LineItem[],
  totalErrors: number,
): ReadinessResult {
  let reviewCount = 0;

  const flagged = items.map((item) => {
    const reasons: string[] = [];

    if ((item.sku_confidence ?? 1.0) < SKU_CONFIDENCE_REVIEW_THRESHOLD) {
      reasons.push("low_sku_confidence");
    }
    const qConf = (item as { quantity_confidence?: number }).quantity_confidence ?? 1.0;
    const uConf = (item as { unit_confidence?: number }).unit_confidence ?? 1.0;
    const pConf = (item as { price_confidence?: number }).price_confidence ?? 1.0;
    if (qConf < FIELD_CONFIDENCE_REVIEW_THRESHOLD) reasons.push("low_quantity_confidence");
    if (uConf < FIELD_CONFIDENCE_REVIEW_THRESHOLD) reasons.push("low_unit_confidence");
    if (pConf < FIELD_CONFIDENCE_REVIEW_THRESHOLD) reasons.push("low_price_confidence");
    if (item.dimensions?.resolution_tier === "HEURISTIC") {
      reasons.push("estimated_dimensions");
    }

    const requiresReview = reasons.length > 0;
    if (requiresReview) reviewCount++;

    return {
      ...item,
      requires_review: requiresReview,
      review_reason: requiresReview ? reasons.join(",") : null,
    };
  });

  return {
    items: flagged,
    items_requiring_review: reviewCount,
    requires_review: reviewCount > 0,
    is_ready_for_invoicing: totalErrors === 0 && reviewCount === 0 && flagged.length > 0,
  };
}

/** Map fuzzy match score [70..100] → confidence [0.60..0.99]. */
export function fuzzyScoreToConfidence(score: number): number {
  if (score < 70) return 0;
  if (score >= 100) return 0.99;
  return Math.round((0.60 + (score - 70) * (0.39 / 30)) * 1000) / 1000;
}
