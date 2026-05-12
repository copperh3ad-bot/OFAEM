// parse-po edge function
//
// POST { document_content: string, source_type: "PDF"|"IMAGE"|"EXCEL"|"EMAIL"|"MANUAL", customer_id: string }
//
// Pipeline:
//   1. Fetch RAG context (top master_articles by description keywords)
//   2. Call Claude Haiku with extraction prompt
//   3. If _confidence.overall < 0.70 → retry on Sonnet
//   4. Reconcile SKUs against master_articles via fuzzy match → adjust sku_confidence
//   5. CBM enrichment (three-tier resolution)
//   6. Apply readiness rollup → is_ready_for_invoicing
//   7. Persist to ai_extractions; emit error_log rows for low-confidence fields

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.30.0";

import { calculateCBM, type LineItem, type MasterArticle } from "../_shared/cbm.ts";
import { applyReadinessFlags, fuzzyScoreToConfidence } from "../_shared/confidence.ts";
import { bestMatch } from "../_shared/fuzzy.ts";
import {
  SYSTEM_PROMPT_PO_EXTRACTION,
  buildFewShotContext,
  PARSING_PIPELINE_VERSION,
} from "../_shared/prompts.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const SONNET_MODEL = "claude-sonnet-4-6";
const LLM_TIMEOUT_MS = 60_000;
const CONFIDENCE_FALLBACK_THRESHOLD = 0.70;
const MAX_TOKENS = 8192;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface ParseRequest {
  document_content: string;
  source_type: "PDF" | "IMAGE" | "EXCEL" | "EMAIL" | "MANUAL";
  customer_id: string;
}

interface RawExtraction {
  metadata: Record<string, unknown> & {
    metadata_confidence?: Record<string, number>;
  };
  line_items: Array<LineItem & {
    quantity_confidence?: number;
    unit_confidence?: number;
    price_confidence?: number;
  }>;
  _confidence: { overall: number };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function extractKeywords(content: string): string[] {
  const words = content.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [];
  const stop = new Set(["the","and","for","with","from","this","that","please","order","purchase","total","unit","price","qty"]);
  const freq = new Map<string, number>();
  for (const w of words) {
    if (stop.has(w)) continue;
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w);
}

async function callAnthropic(
  client: Anthropic,
  model: string,
  systemPrompt: string,
  userContent: string,
): Promise<RawExtraction | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), LLM_TIMEOUT_MS);
  try {
    const resp = await client.messages.create(
      {
        model,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
      },
      { signal: ctl.signal },
    );
    const text = resp.content[0]?.type === "text" ? resp.content[0].text : "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]) as RawExtraction;
  } catch (_e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function fetchMasterArticles(
  supabase: ReturnType<typeof createClient>,
  keywords: string[],
): Promise<MasterArticle[]> {
  if (keywords.length === 0) return [];
  const orClause = keywords.map((k) => `description.ilike.%${k}%`).join(",");
  const { data, error } = await supabase
    .from("master_articles")
    .select("sku, description, unit, category, standard_dimensions")
    .or(orClause)
    .limit(20);
  if (error) return [];
  return (data ?? []) as MasterArticle[];
}

function reconcileSKUs(
  items: RawExtraction["line_items"],
  master: MasterArticle[],
): LineItem[] {
  const masterPairs = master.map((m) => ({
    sku: m.sku,
    description: (m as unknown as { description?: string }).description ?? "",
  }));

  return items.map((item, idx) => {
    const llmConfidence = item.sku_confidence ?? 0.5;
    const match = bestMatch(item.sku, item.description, masterPairs);
    let finalSku = item.sku;
    let skuConfidence = llmConfidence;

    if (match) {
      finalSku = match.sku;
      const fuzzyConf = fuzzyScoreToConfidence(match.score);
      // Take the higher of LLM confidence and fuzzy-derived confidence
      skuConfidence = Math.max(llmConfidence, fuzzyConf);
    } else if (llmConfidence > 0.5) {
      // LLM was confident but no master match → cap confidence at 0.65
      skuConfidence = Math.min(llmConfidence, 0.65);
    }

    return {
      line_no: item.line_no ?? idx + 1,
      sku: finalSku,
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
      unit_price: item.unit_price,
      dimensions: item.dimensions ?? null,
      sku_confidence: skuConfidence,
      quantity_confidence: item.quantity_confidence ?? 0.9,
      unit_confidence: item.unit_confidence ?? 0.9,
      price_confidence: item.price_confidence ?? 0.9,
    } as LineItem & Record<string, unknown>;
  });
}

async function logLowConfidenceFields(
  supabase: ReturnType<typeof createClient>,
  poId: string,
  sourceType: string,
  items: LineItem[],
): Promise<void> {
  const rows: Array<Record<string, unknown>> = [];
  for (const item of items) {
    if (!item.requires_review) continue;
    for (const reason of (item.review_reason ?? "").split(",").filter(Boolean)) {
      rows.push({
        message: `Line ${item.line_no} flagged: ${reason}`,
        severity: "warning",
        category: "extraction",
        context: JSON.stringify({ po_id: poId, line_no: item.line_no, source_type: sourceType, reason }),
      });
    }
  }
  if (rows.length === 0) return;
  await supabase.from("error_log").insert(rows);
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let payload: ParseRequest;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid json body" }, 400);
  }

  if (!payload.document_content || !payload.source_type || !payload.customer_id) {
    return json({ error: "missing required fields: document_content, source_type, customer_id" }, 400);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const keywords = extractKeywords(payload.document_content);
  const masterArticles = await fetchMasterArticles(supabase, keywords);

  const systemPrompt = SYSTEM_PROMPT_PO_EXTRACTION + buildFewShotContext(
    masterArticles.map((m) => ({
      sku: m.sku,
      description: (m as unknown as { description?: string }).description ?? "",
      unit: m.unit ?? "",
    })),
  );

  // Tier 1: Haiku
  let extraction = await callAnthropic(anthropic, HAIKU_MODEL, systemPrompt, payload.document_content);
  let modelUsed = HAIKU_MODEL;

  // Tier 2: Sonnet fallback on low confidence
  if (!extraction || extraction._confidence?.overall < CONFIDENCE_FALLBACK_THRESHOLD) {
    const sonnet = await callAnthropic(anthropic, SONNET_MODEL, systemPrompt, payload.document_content);
    if (sonnet) {
      extraction = sonnet;
      modelUsed = SONNET_MODEL;
    }
  }

  if (!extraction) {
    await supabase.from("error_log").insert({
      message: "LLM extraction returned no parseable JSON",
      severity: "error",
      category: "extraction",
      context: JSON.stringify({ customer_id: payload.customer_id, source_type: payload.source_type }),
    });
    return json({ error: "extraction failed" }, 502);
  }

  // SKU reconciliation
  const reconciledItems = reconcileSKUs(extraction.line_items ?? [], masterArticles);

  // CBM enrichment
  const masterLookup = new Map(masterArticles.map((m) => [m.sku, m]));
  const enriched = calculateCBM(reconciledItems, masterLookup);

  // Readiness rollup
  const readiness = applyReadinessFlags(enriched, 0);

  const totalValue = readiness.items.reduce((s, i) => s + (i.quantity * i.unit_price), 0);
  const totalCBM = readiness.items.reduce((s, i) => s + (i.cbm ?? 0), 0);

  const normalized = {
    metadata: {
      po_id: String(extraction.metadata?.po_id ?? `AUTO-${Date.now()}`),
      po_date: extraction.metadata?.po_date ?? null,
      customer_id: payload.customer_id,
      currency: extraction.metadata?.currency ?? "USD",
      source_document_type: payload.source_type,
      payment_method: extraction.metadata?.payment_method ?? null,
      delivery_destination: extraction.metadata?.delivery_destination ?? null,
      consignee: extraction.metadata?.consignee ?? null,
      extracted_at: new Date().toISOString(),
      parsed_by_version: PARSING_PIPELINE_VERSION,
    },
    line_items: readiness.items,
    flags: {
      is_ready_for_invoicing: readiness.is_ready_for_invoicing,
      requires_review: readiness.requires_review,
      cbm_calculated: true,
    },
    totals: {
      total_items: readiness.items.length,
      total_value: Math.round(totalValue * 100) / 100,
      total_cbm: Math.round(totalCBM * 10000) / 10000,
    },
    validation_summary: {
      total_errors: 0,
      total_warnings: readiness.items_requiring_review,
      items_requiring_review: readiness.items_requiring_review,
      passed: readiness.is_ready_for_invoicing,
    },
  };

  // Persist
  const { data: inserted, error: insertError } = await supabase
    .from("ai_extractions")
    .insert({
      kind: "purchase_order",
      customer_id: payload.customer_id,
      source_type: payload.source_type,
      raw_content: payload.document_content.slice(0, 100_000),
      payload: normalized,
      model_used: modelUsed,
      overall_confidence: extraction._confidence?.overall ?? null,
      is_ready_for_invoicing: readiness.is_ready_for_invoicing,
    })
    .select("id")
    .single();

  if (insertError) {
    return json({ error: `db insert failed: ${insertError.message}` }, 500);
  }

  // Log low-confidence fields for ML loop
  await logLowConfidenceFields(supabase, normalized.metadata.po_id, payload.source_type, readiness.items);

  return json({
    success: true,
    extraction_id: inserted.id,
    normalized_po: normalized,
    model_used: modelUsed,
  });
});
