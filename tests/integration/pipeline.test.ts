// End-to-end pipeline test.
// Requires a running Supabase project with migrations 0001-0004 applied and a seeded master_articles.
// Run: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... ANTHROPIC_API_KEY=... \
//      deno test --allow-env --allow-net tests/integration/pipeline.test.ts
//
// Skips itself if env is not configured (so unit suite stays fast in CI).

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const URL = Deno.env.get("SUPABASE_URL");
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const PARSE_PO_URL = Deno.env.get("PARSE_PO_URL");
const RENDER_PROFORMA_URL = Deno.env.get("RENDER_PROFORMA_URL");

const SAMPLE_EMAIL = `
Subject: PO #ORD-2026-0513-001 - Union Fabrics Order

Dear Supplier,

Please confirm the following purchase order:

PO Number: ORD-2026-0513-001
PO Date: 2026-05-13
Delivery: CIF Port of Hamburg, Germany
Payment Terms: LC at 60 days
Currency: USD

LINE ITEMS:
1. FAB-001-CHK (Checkered Cotton 58") - Qty: 500 meters @ $2.50/meter
2. YRN-001-CTN (Cotton Yarn 40s) - Qty: 100 kg @ $8.00/kg
3. GAR-001-TSH (T-Shirt Adult Large) - Qty: 2000 pieces @ $1.50/piece

Regards,
Union Fabrics Ltd.
`;

const skip = !URL || !KEY || !PARSE_PO_URL;

Deno.test({
  name: "[integration] parse-po → render-proforma end-to-end",
  ignore: skip,
  async fn() {
    const parseResp = await fetch(PARSE_PO_URL!, {
      method: "POST",
      headers: { "Authorization": `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        document_content: SAMPLE_EMAIL,
        source_type: "EMAIL",
        customer_id: "TEST_BUYER",
      }),
    });
    assertEquals(parseResp.status, 200, await parseResp.text());
    const parseBody = await parseResp.json();
    assert(parseBody.success);
    assert(parseBody.extraction_id);
    assertEquals(parseBody.normalized_po.metadata.source_document_type, "EMAIL");
    assert(parseBody.normalized_po.line_items.length >= 1);

    if (!RENDER_PROFORMA_URL) return;  // skip render step if not configured

    const renderResp = await fetch(RENDER_PROFORMA_URL, {
      method: "POST",
      headers: { "Authorization": `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ extraction_id: parseBody.extraction_id }),
    });
    assertEquals(renderResp.status, 200, await renderResp.text());
    const renderBody = await renderResp.json();
    assert(renderBody.success);
    assert(renderBody.checksum?.length === 64, "expected sha256 hex checksum");
    assert(renderBody.html_content.includes("<!DOCTYPE html"));
    // requires_review highlighting present if any reviewed items
    if (parseBody.normalized_po.validation_summary.items_requiring_review > 0) {
      assert(renderBody.html_content.includes("requires-review"));
      assert(renderBody.html_content.includes("REVIEW"));
    }
  },
});
