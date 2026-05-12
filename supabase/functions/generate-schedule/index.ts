// generate-schedule edge function
//
// POST { extraction_id: string, override_production_days?: number }
//
// Reads the extraction + its latest logistical_plan and produces a production
// timeline backed by:
//   po_date           = payload.metadata.po_date  (or today if missing)
//   production_start  = po_date + 2 days
//   production_days   = max(14, total_qty / 1000 * 5)   (override allowed)
//   qa_window         = 7 days after production_end
//   shipping_date     = qa_end + 1 day
//   delivery_date     = payload.metadata wins if present, else shipping_date + transit
//
// Flags schedule_is_tight = true when (delivery_date - shipping_date) < transit_days.

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

function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }
function addDays(d: Date, n: number): Date { const r = new Date(d); r.setUTCDate(r.getUTCDate() + n); return r; }

function baseDocs(shippingMethod: string): string[] {
  const docs = [
    "Commercial Invoice",
    "Packing List",
    "Certificate of Origin",
    "Quality Certificate",
    "Compliance Certificate",
  ];
  if (shippingMethod === "AIR") docs.push("Air Waybill (AWB)", "IATA Shipper's Declaration");
  else if (shippingMethod.startsWith("SEA")) docs.push("Bill of Lading (B/L)", "Container Loading Sheet");
  else if (shippingMethod === "MIXED") docs.push("Bill of Lading (B/L)", "Air Waybill (AWB)");
  return docs;
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const identity = await getCallerIdentity(supabase, req.headers.get("Authorization"), SUPABASE_SERVICE_ROLE_KEY);
  if (!callerHasRole(identity, ALLOWED)) {
    const u = unauthorizedResponse(identity, ALLOWED);
    return json({ error: u.error }, u.status);
  }

  let body: { extraction_id?: string; override_production_days?: number };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  if (!body.extraction_id) return json({ error: "extraction_id is required" }, 400);

  const { data: ext } = await supabase
    .from("ai_extractions")
    .select("id, payload, is_current_version")
    .eq("id", body.extraction_id)
    .single();
  if (!ext) return json({ error: "extraction not found" }, 404);
  if (!ext.is_current_version) return json({ error: "extraction is not the current version" }, 409);

  // Latest logistical plan (required so we know shipping method + transit days)
  const { data: plan } = await supabase
    .from("logistical_plans")
    .select("id, shipping_method, estimated_transit_days")
    .eq("extraction_id", body.extraction_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!plan) return json({ error: "no logistical_plan found; call plan-logistics first" }, 409);

  // deno-lint-ignore no-explicit-any
  const payload = ext.payload as any;
  const poDateStr: string | null = payload?.metadata?.po_date ?? null;
  const buyerDeliveryStr: string | null = payload?.metadata?.delivery_date ?? null;
  const poDate = poDateStr ? new Date(poDateStr) : new Date();

  const lineItems: Array<{ quantity: number }> = payload?.line_items ?? [];
  const totalQty = lineItems.reduce((s, l) => s + (l.quantity ?? 0), 0);
  const productionDays = body.override_production_days
    ?? Math.max(14, Math.ceil(totalQty / 1000) * 5);

  const productionStart = addDays(poDate, 2);
  const productionEnd   = addDays(productionStart, productionDays);
  const qaStart         = productionEnd;
  const qaEnd           = addDays(qaStart, 7);
  const shippingDate    = addDays(qaEnd, 1);

  const transitDays = plan.estimated_transit_days as number;
  const computedDelivery = addDays(shippingDate, transitDays);
  const finalDelivery = buyerDeliveryStr ? new Date(buyerDeliveryStr) : computedDelivery;

  // Is the buyer's delivery date too tight given our production + transit?
  const bufferDays = Math.floor((finalDelivery.getTime() - computedDelivery.getTime()) / (24 * 3600 * 1000));
  const scheduleTight = bufferDays < 0;

  const { data: schedule, error: insErr } = await supabase
    .from("production_schedules")
    .insert({
      extraction_id: body.extraction_id,
      logistical_plan_id: plan.id,
      po_date: isoDate(poDate),
      production_start: isoDate(productionStart),
      production_end: isoDate(productionEnd),
      qa_start: isoDate(qaStart),
      qa_end: isoDate(qaEnd),
      shipping_date: isoDate(shippingDate),
      delivery_date: isoDate(finalDelivery),
      documentation_required: baseDocs(plan.shipping_method as string),
      schedule_is_tight: scheduleTight,
      buffer_days: bufferDays,
      notes: scheduleTight
        ? `Buyer delivery date is ${Math.abs(bufferDays)} day(s) BEFORE our computed earliest delivery. Escalate.`
        : `${bufferDays} day(s) buffer between our earliest delivery and buyer requested.`,
    })
    .select()
    .single();

  if (insErr) return json({ error: `db insert failed: ${insErr.message}` }, 500);

  return json({ success: true, schedule, schedule_is_tight: scheduleTight, buffer_days: bufferDays });
});
