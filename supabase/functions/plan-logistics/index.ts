// plan-logistics edge function
//
// POST { extraction_id: string }
//
// Reads the latest current-version PO extraction, computes total CBM + weight
// from line_items, recommends a shipping method using rules:
//   CBM <  3       → AIR        ( 3 days, 1.5× base cost)
//   CBM <  8       → SEA_LCL    (18 days, 1.1× base cost) — consolidation candidate
//   CBM < 20       → MIXED      ( 7 days, 1.2× base cost)
//   CBM >= 20      → SEA_FCL    (21 days, 1.0× base cost)
//
// Persists to logistical_plans. Role-gated to Owner/Manager/Merchandiser.

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { getCallerIdentity, callerHasRole, unauthorizedResponse } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const ALLOWED = ["Owner", "Manager", "Merchandiser"];

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

interface ShippingRule {
  method: "AIR" | "SEA_LCL" | "MIXED" | "SEA_FCL";
  transit_days: number;
  cost_multiplier: number;
  consolidation: boolean;
  rationale: string;
}

function pickShippingRule(totalCbm: number): ShippingRule {
  if (totalCbm < 3) {
    return { method: "AIR", transit_days: 3, cost_multiplier: 1.5, consolidation: false,
             rationale: `Volume ${totalCbm.toFixed(2)} m³ < 3 m³ — air freight cost-justified for fast transit.` };
  }
  if (totalCbm < 8) {
    return { method: "SEA_LCL", transit_days: 18, cost_multiplier: 1.1, consolidation: true,
             rationale: `Volume ${totalCbm.toFixed(2)} m³ — LCL recommended; consolidate with other orders to fill an FCL if available.` };
  }
  if (totalCbm < 20) {
    return { method: "MIXED", transit_days: 7, cost_multiplier: 1.2, consolidation: false,
             rationale: `Volume ${totalCbm.toFixed(2)} m³ — split shipment: time-critical SKUs by air, bulk by sea.` };
  }
  return { method: "SEA_FCL", transit_days: 21, cost_multiplier: 1.0, consolidation: false,
           rationale: `Volume ${totalCbm.toFixed(2)} m³ ≥ 20 m³ — full container load most cost-effective.` };
}

function buildPackagingRequirements(rule: ShippingRule, totalWeightKg: number): string[] {
  const reqs = ["Standard export cartons", "Pallet bracing", "Gross-weight labels per carton"];
  if (rule.method === "AIR") reqs.push("IATA dangerous-goods declaration if applicable", "Volumetric weight check (167 kg/m³)");
  if (rule.method.startsWith("SEA")) reqs.push("Container packing list (CY/CFS)", "Desiccant for humidity-sensitive textiles");
  if (totalWeightKg > 1000) reqs.push("Forklift handling instructions");
  if (rule.consolidation) reqs.push("Mark cartons for LCL consolidation (origin warehouse code)");
  return reqs;
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Authz
  const identity = await getCallerIdentity(supabase, req.headers.get("Authorization"), SUPABASE_SERVICE_ROLE_KEY);
  if (!callerHasRole(identity, ALLOWED)) {
    const u = unauthorizedResponse(identity, ALLOWED);
    return json({ error: u.error }, u.status);
  }

  let body: { extraction_id?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  if (!body.extraction_id) return json({ error: "extraction_id is required" }, 400);

  const { data: ext, error: extErr } = await supabase
    .from("ai_extractions")
    .select("id, customer_id, payload, is_current_version")
    .eq("id", body.extraction_id)
    .single();
  if (extErr || !ext) return json({ error: "extraction not found" }, 404);
  if (!ext.is_current_version) return json({ error: "extraction is not the current version" }, 409);

  // deno-lint-ignore no-explicit-any
  const payload = ext.payload as any;
  const lineItems: Array<{ quantity: number; cbm: number | null; unit: string }> = payload?.line_items ?? [];
  const totalCbm = lineItems.reduce((s, l) => s + (l.cbm ?? 0), 0);
  const totalWeightKg = lineItems.reduce((s, l) => {
    // Weight not currently captured per line; approximate as quantity for PIECE,
    // or use cbm × 167 (IATA volumetric inverse) as a proxy. Replace with real
    // weight once line items carry kg.
    return s + (l.cbm ?? 0) * 167;
  }, 0);

  if (totalCbm <= 0) {
    return json({ error: "extraction has no CBM data — cannot plan logistics" }, 422);
  }

  const rule = pickShippingRule(totalCbm);
  const currency = payload?.metadata?.currency ?? "USD";
  const orderValue = payload?.totals?.total_value ?? 0;
  const estimatedCost = Math.round(orderValue * rule.cost_multiplier * 100) / 100;

  const { data: plan, error: insErr } = await supabase
    .from("logistical_plans")
    .insert({
      extraction_id: body.extraction_id,
      shipping_method: rule.method,
      estimated_transit_days: rule.transit_days,
      estimated_cost: estimatedCost,
      cost_currency: currency,
      consolidation_recommended: rule.consolidation,
      packaging_requirements: buildPackagingRequirements(rule, totalWeightKg),
      rationale: rule.rationale,
      total_cbm_used: Math.round(totalCbm * 10000) / 10000,
      total_weight_kg_used: Math.round(totalWeightKg * 1000) / 1000,
      created_by: identity.user_id,
    })
    .select()
    .single();

  if (insErr) return json({ error: `db insert failed: ${insErr.message}` }, 500);

  return json({ success: true, plan });
});
