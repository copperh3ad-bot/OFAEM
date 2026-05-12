// crisis-alert edge function
//
// Two modes:
//
//   1) Raise a new crisis
//      POST { extraction_id: string, crisis_type: string, severity: string, details: string }
//      Inserts a crisis_alerts row, then calls Claude to produce a structured
//      mitigation plan tailored to the actual PO context. The plan is stored
//      on the row and returned in the response.
//
//   2) Resolve an existing crisis (Owner/Manager only)
//      POST { crisis_id: string, action: "resolve", resolution_notes: string }
//      Marks the row resolved and returns it. The workflow_state view picks up
//      the change automatically.

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.30.0";
import { getCallerIdentity, callerHasRole, unauthorizedResponse } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

const RAISE_ALLOWED   = ["Owner", "Manager", "Merchandiser", "QC Inspector"];
const RESOLVE_ALLOWED = ["Owner", "Manager"];

const MITIGATION_MODEL = "claude-haiku-4-5-20251001";
const MITIGATION_TIMEOUT_MS = 20_000;

const CRISIS_TYPES = new Set([
  "production_delay", "quality_issue", "logistics_problem",
  "payment_issue", "compliance_failure", "customs_hold", "other",
]);
const SEVERITIES = new Set(["low", "medium", "high", "critical"]);

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

const MITIGATION_SYSTEM_PROMPT = `You are an experienced textile-manufacturing operations manager.

A crisis has been raised on an active purchase order. You will be given:
- the PO context (buyer, customer, total value, key line items, shipping plan, schedule if available)
- the crisis type and severity
- a free-text incident description

Produce a structured mitigation plan as a single JSON object — no prose, no markdown:

{
  "immediate_actions": ["3-5 concrete, time-bound first steps an operator can take today"],
  "responsible_owner": "<which role should drive this: Manager / QC Inspector / Logistics Coordinator / Finance>",
  "communication_strategy": "<one short paragraph: who to inform, how often, what to say>",
  "contingency_timeline_days": <integer: expected calendar-day impact on delivery; 0 if no impact>,
  "escalation_path": ["1-3 escalation steps if immediate_actions do not resolve in 24-48h"],
  "risk_assessment": {
    "recovery_probability": "<low|medium|high>",
    "business_impact": "<short sentence>",
    "buyer_relationship_risk": "<short sentence>"
  },
  "preventive_actions": ["1-3 process improvements to reduce recurrence"]
}

Be SPECIFIC to the PO and crisis — do not return generic templates. Reference SKUs, quantities,
the shipping method, and the buyer when relevant.`;

interface PayloadShape {
  metadata?: {
    po_id?: string; customer_id?: string; currency?: string;
    payment_method?: string | null; delivery_destination?: string | null; po_date?: string | null;
  };
  line_items?: Array<{ sku: string; description: string; quantity: number; unit: string; unit_price: number }>;
  totals?: { total_items?: number; total_value?: number; total_cbm?: number };
}

function buildCrisisContext(
  payload: PayloadShape,
  plan: { shipping_method: string; estimated_transit_days: number } | null,
  schedule: { shipping_date: string; delivery_date: string; schedule_is_tight: boolean } | null,
  crisisType: string,
  severity: string,
  details: string,
): string {
  const md = payload.metadata ?? {};
  const totals = payload.totals ?? {};
  const items = (payload.line_items ?? []).slice(0, 10).map((l) =>
    `  - ${l.sku} (${l.description}): qty=${l.quantity} ${l.unit} @ ${l.unit_price}`
  ).join("\n");
  return `PO context:
  po_id:             ${md.po_id ?? "?"}
  buyer/customer:    ${md.customer_id ?? "?"}
  currency:          ${md.currency ?? "?"}
  payment_method:    ${md.payment_method ?? "?"}
  delivery_dest:     ${md.delivery_destination ?? "?"}
  po_date:           ${md.po_date ?? "?"}
  total_value:       ${totals.total_value ?? "?"} ${md.currency ?? ""}
  total_cbm_m3:      ${totals.total_cbm ?? "?"}
  line_items_count:  ${totals.total_items ?? "?"}
${items ? "\nTop line items:\n" + items : ""}

Logistical plan: ${plan ? `${plan.shipping_method} (${plan.estimated_transit_days} days transit)` : "(not yet planned)"}
Schedule: ${schedule ? `ship ${schedule.shipping_date}, deliver ${schedule.delivery_date}${schedule.schedule_is_tight ? " — TIGHT" : ""}` : "(not yet scheduled)"}

Crisis raised:
  type:     ${crisisType}
  severity: ${severity}
  details:  ${details}`;
}

async function generateMitigation(
  anthropic: Anthropic,
  context: string,
): Promise<{ plan: Record<string, unknown> | null; model: string; debug?: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), MITIGATION_TIMEOUT_MS);
  try {
    const resp = await anthropic.messages.create({
      model: MITIGATION_MODEL,
      max_tokens: 1024,
      system: MITIGATION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: context }],
    }, { signal: ctl.signal });
    const text = resp.content[0]?.type === "text" ? resp.content[0].text : "";
    if (!text) return { plan: null, model: MITIGATION_MODEL, debug: "empty_response" };
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { plan: null, model: MITIGATION_MODEL, debug: `no_json_in_response:${text.slice(0,200)}` };
    try {
      return { plan: JSON.parse(match[0]) as Record<string, unknown>, model: MITIGATION_MODEL };
    } catch (parseErr) {
      return { plan: null, model: MITIGATION_MODEL, debug: `json_parse_failed:${(parseErr as Error).message}` };
    }
  } catch (e) {
    return { plan: null, model: MITIGATION_MODEL, debug: `anthropic_error:${(e as Error).message}` };
  } finally {
    clearTimeout(t);
  }
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const identity = await getCallerIdentity(supabase, req.headers.get("Authorization"), SUPABASE_SERVICE_ROLE_KEY);

  let body: {
    extraction_id?: string;
    crisis_type?: string;
    severity?: string;
    details?: string;
    crisis_id?: string;
    action?: "resolve";
    resolution_notes?: string;
  };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }

  // ── RESOLVE MODE ────────────────────────────────────────────────────────
  if (body.action === "resolve") {
    if (!callerHasRole(identity, RESOLVE_ALLOWED)) {
      const u = unauthorizedResponse(identity, RESOLVE_ALLOWED);
      return json({ error: u.error }, u.status);
    }
    if (!body.crisis_id) return json({ error: "crisis_id is required to resolve" }, 400);

    const { data: resolved, error } = await supabase
      .from("crisis_alerts")
      .update({
        status: "resolved",
        resolved_at: new Date().toISOString(),
        resolved_by: identity.user_id,
        resolution_notes: body.resolution_notes ?? null,
      })
      .eq("id", body.crisis_id)
      .select()
      .single();
    if (error) return json({ error: `update failed: ${error.message}` }, 500);
    return json({ success: true, crisis: resolved });
  }

  // ── RAISE MODE ──────────────────────────────────────────────────────────
  if (!callerHasRole(identity, RAISE_ALLOWED)) {
    const u = unauthorizedResponse(identity, RAISE_ALLOWED);
    return json({ error: u.error }, u.status);
  }
  if (!body.extraction_id || !body.crisis_type || !body.severity || !body.details) {
    return json({ error: "extraction_id, crisis_type, severity, details are required" }, 400);
  }
  if (!CRISIS_TYPES.has(body.crisis_type)) return json({ error: `unknown crisis_type: ${body.crisis_type}` }, 400);
  if (!SEVERITIES.has(body.severity)) return json({ error: `severity must be one of low|medium|high|critical` }, 400);

  const { data: ext } = await supabase
    .from("ai_extractions")
    .select("id, payload, is_current_version")
    .eq("id", body.extraction_id)
    .single();
  if (!ext) return json({ error: "extraction not found" }, 404);
  if (!ext.is_current_version) return json({ error: "extraction is not the current version" }, 409);

  const { data: plan } = await supabase
    .from("logistical_plans")
    .select("shipping_method, estimated_transit_days")
    .eq("extraction_id", body.extraction_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: schedule } = await supabase
    .from("production_schedules")
    .select("shipping_date, delivery_date, schedule_is_tight")
    .eq("extraction_id", body.extraction_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: inserted, error: insErr } = await supabase
    .from("crisis_alerts")
    .insert({
      extraction_id: body.extraction_id,
      crisis_type: body.crisis_type,
      severity: body.severity,
      details: body.details,
      status: "active",
      raised_by: identity.user_id,
    })
    .select()
    .single();
  if (insErr) return json({ error: `db insert failed: ${insErr.message}` }, 500);

  // Generate LLM mitigation plan against the actual PO context
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const context = buildCrisisContext(
    ext.payload as PayloadShape,
    plan as { shipping_method: string; estimated_transit_days: number } | null,
    schedule as { shipping_date: string; delivery_date: string; schedule_is_tight: boolean } | null,
    body.crisis_type, body.severity, body.details,
  );
  const { plan: mitigation, model, debug: mitigationDebug } = await generateMitigation(anthropic, context);

  if (mitigation) {
    await supabase
      .from("crisis_alerts")
      .update({ mitigation_plan: mitigation, mitigation_model: model, status: "mitigating" })
      .eq("id", inserted.id);
    (inserted as Record<string, unknown>).mitigation_plan = mitigation;
    (inserted as Record<string, unknown>).status = "mitigating";
    (inserted as Record<string, unknown>).mitigation_model = model;
  }

  return json({
    success: true,
    crisis: inserted,
    mitigation_generated: mitigation !== null,
    mitigation_debug: mitigation === null ? mitigationDebug : undefined,
  });
});
