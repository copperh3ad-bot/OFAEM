// render-proforma edge function
//
// POST { extraction_id: string, output_format?: "HTML" }
//
// Reads ai_extractions.payload, renders proforma_invoice.html via Eta,
// writes to Storage, records checksum + path in proforma_invoices.
// Sign-off (is_ready_for_invoicing flip on the row) is gated to Owner/Manager
// by a Postgres trigger — this function only sets the initial state.

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { Eta } from "https://deno.land/x/eta@v3.4.0/src/index.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const PROFORMA_BUCKET = "proforma-invoices";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const TEMPLATE = await Deno.readTextFile(new URL("./template.eta", import.meta.url));

interface NormalizedPO {
  metadata: {
    po_id: string;
    po_date: string | null;
    customer_id: string;
    currency: string;
    payment_method: string | null;
    delivery_destination: string | null;
    consignee: string | null;
    extracted_at: string;
  };
  line_items: Array<{
    line_no: number;
    sku: string;
    description: string;
    quantity: number;
    unit: string;
    unit_price: number;
    cbm: number | null;
    sku_confidence: number;
    requires_review: boolean;
    review_reason: string | null;
  }>;
  flags: { is_ready_for_invoicing: boolean; requires_review: boolean };
  totals: { total_items: number; total_value: number; total_cbm: number };
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: { extraction_id?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }

  const { extraction_id } = body;
  if (!extraction_id) return json({ error: "missing extraction_id" }, 400);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: extraction, error: fetchErr } = await supabase
    .from("ai_extractions")
    .select("id, payload, customer_id, kind")
    .eq("id", extraction_id)
    .single();

  if (fetchErr || !extraction) return json({ error: "extraction not found" }, 404);
  if (extraction.kind !== "purchase_order") return json({ error: "extraction is not a purchase_order" }, 400);

  const po = extraction.payload as NormalizedPO;

  // Render template
  const eta = new Eta({ autoEscape: true });
  const lineItems = po.line_items.map((item) => ({
    ...item,
    line_total: Math.round(item.quantity * item.unit_price * 100) / 100,
    status_badge: item.requires_review ? "REVIEW" : "OK",
    status_class: item.requires_review ? "requires-review" : "ok",
  }));

  const html = eta.renderString(TEMPLATE, {
    company_name: "Union Fabrics Ltd.",
    invoice_date: new Date().toISOString().split("T")[0],
    po,
    line_items: lineItems,
    review_count: po.totals ? po.line_items.filter((i) => i.requires_review).length : 0,
    generated_timestamp: new Date().toISOString(),
  }) ?? "";

  const checksum = await sha256Hex(html);
  const filePath = `${extraction.customer_id}/${po.metadata.po_id}_${checksum.slice(0, 8)}.html`;

  // Ensure bucket exists (idempotent)
  await supabase.storage.createBucket(PROFORMA_BUCKET, { public: false }).catch(() => {});

  const { error: uploadErr } = await supabase.storage
    .from(PROFORMA_BUCKET)
    .upload(filePath, html, { contentType: "text/html", upsert: true });

  if (uploadErr) return json({ error: `storage upload failed: ${uploadErr.message}` }, 500);

  const { data: invoiceRow, error: insertErr } = await supabase
    .from("proforma_invoices")
    .insert({
      extraction_id,
      po_id: po.metadata.po_id,
      customer_id: extraction.customer_id,
      file_path: filePath,
      checksum,
      total_value: po.totals.total_value,
      total_cbm: po.totals.total_cbm,
      is_ready_for_invoicing: false, // Owner/Manager flips this manually via update
    })
    .select("id, file_path, checksum, generated_at")
    .single();

  if (insertErr) return json({ error: `db insert failed: ${insertErr.message}` }, 500);

  return json({
    success: true,
    invoice_id: invoiceRow.id,
    file_path: invoiceRow.file_path,
    checksum: invoiceRow.checksum,
    html_content: html,
    generated_at: invoiceRow.generated_at,
  });
});
