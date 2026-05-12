// record-quality edge function
//
// POST {
//   extraction_id: string,
//   defect_rate_percentage: number,  // 0..100
//   passed: boolean,                  // required outcome
//   certificate_types?: string[],     // e.g. ["AZO-free","GOTS","OEKO-TEX"]
//   notes?: string,
//   defect_rate_threshold?: number    // default 2.0; failure if defect > threshold OR passed=false
// }
//
// Role-gated to QC Inspector / Manager / Owner.
//
// When the assessment fails (passed=false OR defect_rate > threshold), the
// function automatically raises a crisis_alerts row of type
// 'compliance_failure' with severity scaled to defect_rate.

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { getCallerIdentity, callerHasRole, unauthorizedResponse } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const ALLOWED = ["Owner", "Manager", "QC Inspector"];

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

function severityForDefectRate(defectRate: number): "low" | "medium" | "high" | "critical" {
  if (defectRate >= 10) return "critical";
  if (defectRate >= 5) return "high";
  if (defectRate >= 2) return "medium";
  return "low";
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

  let body: {
    extraction_id?: string;
    defect_rate_percentage?: number;
    passed?: boolean;
    certificate_types?: string[];
    notes?: string;
    defect_rate_threshold?: number;
  };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }

  if (!body.extraction_id) return json({ error: "extraction_id is required" }, 400);
  if (typeof body.defect_rate_percentage !== "number" || body.defect_rate_percentage < 0 || body.defect_rate_percentage > 100) {
    return json({ error: "defect_rate_percentage must be a number between 0 and 100" }, 400);
  }
  if (typeof body.passed !== "boolean") return json({ error: "passed must be a boolean" }, 400);

  const threshold = body.defect_rate_threshold ?? 2.0;
  const computedPassed = body.passed && body.defect_rate_percentage <= threshold;

  const { data: ext } = await supabase
    .from("ai_extractions")
    .select("id, customer_id, payload, is_current_version")
    .eq("id", body.extraction_id)
    .single();
  if (!ext) return json({ error: "extraction not found" }, 404);
  if (!ext.is_current_version) return json({ error: "extraction is not the current version" }, 409);

  const { data: record, error: insErr } = await supabase
    .from("compliance_records")
    .insert({
      extraction_id: body.extraction_id,
      defect_rate_percentage: body.defect_rate_percentage,
      passed_certification: computedPassed,
      certificate_types: body.certificate_types ?? [],
      notes: body.notes ?? null,
      inspected_by: identity.user_id,
      approved_by: computedPassed ? identity.user_id : null,
    })
    .select()
    .single();

  if (insErr) return json({ error: `db insert failed: ${insErr.message}` }, 500);

  let crisis: unknown = null;
  if (!computedPassed) {
    const severity = severityForDefectRate(body.defect_rate_percentage);
    // deno-lint-ignore no-explicit-any
    const payload = ext.payload as any;
    const { data: crisisRow } = await supabase
      .from("crisis_alerts")
      .insert({
        extraction_id: body.extraction_id,
        crisis_type: "compliance_failure",
        severity,
        details: `Quality assessment failed: defect_rate ${body.defect_rate_percentage}% (threshold ${threshold}%), passed=${body.passed}. ${body.notes ?? ""}`.trim(),
        raised_by: identity.user_id,
        mitigation_plan: null,  // crisis-alert function would normally generate this; for inline failures it's left null for a Manager to trigger
      })
      .select()
      .single();
    crisis = crisisRow;
  }

  return json({
    success: true,
    compliance_record: record,
    passed: computedPassed,
    crisis_raised: crisis !== null,
    crisis,
  });
});
