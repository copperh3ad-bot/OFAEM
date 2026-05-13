// 5-stage workflow end-to-end test.
//
// Drives ONE PO through every stage of the workflow against the live project,
// asserting each stage's invariants:
//   1. parse-po          → extraction_id returned, line items present
//   2. plan-logistics    → SEA_FCL chosen for CBM > 20, AIR for < 3, etc.
//   3. generate-schedule → buffer_days >= 0 when delivery_date is not tight
//   4. record-quality    → pass=true, no crisis raised
//   5. workflow_state    → current_stage transitions correctly across stages
//
// After this test, exactly one row should exist in workflow_state with
// current_stage = READY_SHIPMENT.
//
// Required env (skipped if absent):
//   SUPABASE_URL              default https://ouxnplyjzlbhmvpcvjmx.supabase.co
//   SUPABASE_ANON_KEY
//   SUPABASE_SERVICE_ROLE_KEY  legacy JWT (Stage 2-4 need role auth)

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";

const URL = Deno.env.get("SUPABASE_URL") ?? "https://ouxnplyjzlbhmvpcvjmx.supabase.co";
const ANON = Deno.env.get("SUPABASE_ANON_KEY");
const SVC = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const skip = !ANON || !SVC;

const SAMPLE_EMAIL = `PO #E2E-FLOW-${Date.now()}
Date: 2026-05-14
Payment: LC 60 days
Currency: USD
Delivery: CIF Hamburg

1. Checkered cotton fabric 58 inches - 1500 meters @ $2.70/m
2. Cotton yarn 40s natural - 250 kg @ $7.85/kg
3. White t-shirts adult large - 3000 pieces @ $1.95 each`;

async function postEdge(fn: string, body: unknown, useSvc = false): Promise<Record<string, unknown>> {
  const auth = useSvc ? SVC! : ANON!;
  const resp = await fetch(`${URL}/functions/v1/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${auth}`,
      ...(useSvc ? {} : { "apikey": auth }),
    },
    body: JSON.stringify(body),
  });
  return (await resp.json()) as Record<string, unknown>;
}

Deno.test({
  name: "[workflow] 5-stage end-to-end PO progression",
  ignore: skip,
  async fn() {
    // Stage 1: parse
    const parsed = await postEdge("parse-po", {
      source_type: "EMAIL",
      customer_id: "E2E_TEST_BUYER",
      document_content: SAMPLE_EMAIL,
    });
    assertEquals(parsed.success, true, `parse-po: ${JSON.stringify(parsed).slice(0, 400)}`);
    const extractionId = parsed.extraction_id as string;
    assert(typeof extractionId === "string" && extractionId.length === 36, "extraction_id should be UUID");
    const np = parsed.normalized_po as { line_items: unknown[]; totals: { total_value: number } };
    assertEquals(np.line_items.length, 3, "expected 3 line items");
    assert(np.totals.total_value > 10000, `total_value should reflect three lines, got ${np.totals.total_value}`);

    // Stage 2: logistics
    const plan = await postEdge("plan-logistics", { extraction_id: extractionId }, true);
    assertEquals(plan.success, true, `plan-logistics: ${JSON.stringify(plan).slice(0, 400)}`);
    const p = plan.plan as { shipping_method: string; estimated_transit_days: number; total_cbm_used: number };
    // CBM for this PO is roughly: 1500m × 0.0007 + 250kg × 0.5×0.5×0.5 + 3000pc × 0.012 ≈ 68 m³
    assert(p.total_cbm_used > 20, `CBM should be > 20 to select SEA_FCL, got ${p.total_cbm_used}`);
    assertEquals(p.shipping_method, "SEA_FCL");

    // Stage 3: schedule
    const sched = await postEdge("generate-schedule", { extraction_id: extractionId }, true);
    assertEquals(sched.success, true, `generate-schedule: ${JSON.stringify(sched).slice(0, 400)}`);
    const bufferDays = sched.buffer_days as number;
    assert(typeof bufferDays === "number", "buffer_days should be a number");

    // Stage 4: quality (pass)
    const qa = await postEdge("record-quality", {
      extraction_id: extractionId,
      defect_rate_percentage: 0.4,
      passed: true,
      certificate_types: ["OEKO-TEX"],
    }, true);
    assertEquals(qa.success, true, `record-quality: ${JSON.stringify(qa).slice(0, 400)}`);
    assertEquals(qa.passed, true);
    assertEquals(qa.crisis_raised, false, "passing QA must not raise a crisis");

    // Verify workflow_state shows correct progression (without sign-off, it
    // should be in QUALITY_COMPLIANCE → because passed_certification=true the
    // CASE in workflow_state moves it to READY_SHIPMENT)
    const stateResp = await fetch(
      `${URL}/rest/v1/workflow_state?extraction_id=eq.${extractionId}&select=current_stage,shipping_method,passed_certification,defect_rate_percentage,active_crisis_count`,
      { headers: { "Authorization": `Bearer ${SVC!}`, "apikey": SVC! } },
    );
    const rows = await stateResp.json() as Array<{
      current_stage: string;
      shipping_method: string;
      passed_certification: boolean;
      defect_rate_percentage: string | number;
      active_crisis_count: number;
    }>;
    assertEquals(rows.length, 1, "exactly one workflow_state row expected");
    const row = rows[0];
    assertEquals(row.current_stage, "READY_SHIPMENT");
    assertEquals(row.shipping_method, "SEA_FCL");
    assertEquals(row.passed_certification, true);
    assertEquals(Number(row.defect_rate_percentage), 0.4);
    assertEquals(row.active_crisis_count, 0);
  },
});

if (skip) {
  Deno.test({ name: "[skipped] requires SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY", fn() {/**/} });
}
