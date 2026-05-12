// parse-po edge function
//
// Accepts:
//   EMAIL / MANUAL  → { document_content: string, ... }
//   PDF             → { file_base64: string, file_mime: "application/pdf", ... }
//   IMAGE           → { file_base64: string, file_mime: "image/jpeg|png|webp", ... }
//   EXCEL           → { file_base64: string, file_mime: "application/vnd.openxml...", ... }
//
// Pipeline:
//   1. Decode binary input or read text (EXCEL is converted to text via SheetJS first)
//   2. Fetch RAG context (top master_articles by pg_trgm similarity to a text proxy)
//   3. Call Claude Haiku with extraction prompt — content blocks vary by source_type
//   4. If _confidence.overall < 0.70 → retry on Sonnet
//   5. AI SKU matching: per-line trigram pre-filter → Claude disambiguation
//   6. CBM enrichment (three-tier resolution)
//   7. Apply readiness rollup → is_ready_for_invoicing
//   8. Persist to ai_extractions; emit error_log rows for low-confidence fields

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.30.0";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import JSZip from "https://esm.sh/jszip@3.10.1";
import PostalMime from "https://esm.sh/postal-mime@2.4.3";

import { calculateCBM, type LineItem, type MasterArticle } from "../_shared/cbm.ts";
import { applyReadinessFlags } from "../_shared/confidence.ts";
import { matchSKU } from "../_shared/sku_matcher.ts";
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
const LLM_TIMEOUT_MS = 120_000;          // PDFs and images need longer
const CONFIDENCE_FALLBACK_THRESHOLD = 0.70;
const MAX_TOKENS = 8192;
const MAX_FILE_BYTES = 8 * 1024 * 1024;  // 8 MB raw (Supabase request body cap is ~6 MB after base64)

const PDF_MIME = "application/pdf";
const IMAGE_MIMES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"]);
const XLSX_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);
const MAX_INLINE_IMAGES = 6;  // cap total image blocks sent to Claude (token cost control)

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface InlineAttachment {
  file_base64: string;
  file_mime: string;
  filename?: string;
}

interface ParseRequest {
  document_content?: string;          // EMAIL / MANUAL: plain text body
  raw_email?: string;                 // EMAIL: full RFC822 / MIME multipart — inline images extracted automatically
  file_base64?: string;               // PDF / IMAGE / EXCEL — raw base64 (no data: prefix)
  file_mime?: string;                 // required when file_base64 is set
  attachments?: InlineAttachment[];   // additional images to include for any source_type
  source_type: "PDF" | "IMAGE" | "EXCEL" | "EMAIL" | "MANUAL";
  customer_id: string;
}

type UserContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string } };

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

async function callAnthropic(
  client: Anthropic,
  model: string,
  systemPrompt: string,
  userContent: string | UserContentBlock[],
): Promise<RawExtraction | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), LLM_TIMEOUT_MS);
  try {
    const resp = await client.messages.create(
      {
        model,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent as unknown as string }],
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

function decodeBase64Size(b64: string): number {
  // Approx byte count without decoding: base64 length × 3/4, minus padding
  const stripped = b64.replace(/\s+/g, "").replace(/^data:[^;]+;base64,/, "");
  const padding = (stripped.match(/=+$/) ?? [""])[0].length;
  return Math.floor((stripped.length * 3) / 4) - padding;
}

function decodeBase64ToBytes(b64: string): Uint8Array {
  const stripped = b64.replace(/\s+/g, "").replace(/^data:[^;]+;base64,/, "");
  const binary = atob(stripped);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function xlsxBase64ToText(b64: string): string {
  const bytes = decodeBase64ToBytes(b64);
  const wb = XLSX.read(bytes, { type: "array" });
  const sheets: string[] = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false });
    if (csv.trim()) {
      sheets.push(`--- Sheet: ${sheetName} ---\n${csv}`);
    }
  }
  return sheets.join("\n\n");
}

function bytesToBase64(bytes: Uint8Array): string {
  // Chunked to avoid argument stack overflow on large buffers
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return btoa(binary);
}

function mimeFromExtension(filename: string): string | null {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "png":  return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "gif":  return "image/gif";
    default:     return null;  // emf/wmf/vector formats not supported by Anthropic
  }
}

/**
 * Extract embedded images from an xlsx file. Images live in xl/media/ within
 * the .xlsx zip — both pasted "Insert Picture" and "Insert Picture in Cell"
 * end up there. Returns base64-encoded image attachments suitable for
 * Anthropic image content blocks.
 */
async function extractXlsxImages(b64: string): Promise<InlineAttachment[]> {
  try {
    const bytes = decodeBase64ToBytes(b64);
    const zip = await JSZip.loadAsync(bytes);
    const out: InlineAttachment[] = [];
    for (const path of Object.keys(zip.files)) {
      if (!path.startsWith("xl/media/")) continue;
      const file = zip.files[path];
      if (file.dir) continue;
      const filename = path.split("/").pop() ?? "";
      const mime = mimeFromExtension(filename);
      if (!mime) continue;
      const data = await file.async("uint8array");
      if (data.length === 0) continue;
      out.push({ file_base64: bytesToBase64(data), file_mime: mime, filename });
    }
    return out;
  } catch (_e) {
    return [];
  }
}

/**
 * Parse RFC822 MIME email into a text body + inline image attachments.
 * Handles multipart/related (Outlook-style cid: references), multipart/mixed
 * (regular attachments), and quoted-printable / base64 encodings transparently.
 */
async function parseRawEmail(raw: string): Promise<{
  text: string;
  attachments: InlineAttachment[];
}> {
  try {
    // postal-mime is iso-edge-runtime compatible
    // deno-lint-ignore no-explicit-any
    const email = await (PostalMime as any).parse(raw);
    const text = (email.text ?? stripHtml(email.html ?? "") ?? "").toString();
    const attachments: InlineAttachment[] = [];
    for (const att of email.attachments ?? []) {
      const mime: string = att.mimeType ?? "";
      if (!mime.startsWith("image/")) continue;
      // postal-mime returns content as ArrayBuffer
      const buf: ArrayBuffer = att.content;
      const bytes = new Uint8Array(buf);
      attachments.push({
        file_base64: bytesToBase64(bytes),
        file_mime: mime,
        filename: att.filename ?? undefined,
      });
    }
    return { text, attachments };
  } catch (_e) {
    // Fallback: treat as plain text
    return { text: raw, attachments: [] };
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function attachmentToBlock(att: InlineAttachment): UserContentBlock | null {
  if (!IMAGE_MIMES.has(att.file_mime)) return null;
  return {
    type: "image",
    source: { type: "base64", media_type: att.file_mime, data: att.file_base64 },
  };
}

/**
 * Build the user content for the extraction LLM call based on source type.
 * Returns either a plain string (for text inputs) or an array of content
 * blocks (for PDF/IMAGE — required for Anthropic document/image support).
 *
 * Also returns a `text_proxy` used for trigram RAG retrieval; for binary
 * inputs this is the source_type label + customer_id (RAG isn't useful
 * until after first-pass extraction in that case).
 */
async function buildUserContent(req: ParseRequest): Promise<{
  content: string | UserContentBlock[];
  text_proxy: string;
  error?: string;
  inline_images_found?: number;
}> {
  const st = req.source_type;
  const callerAttachments = (req.attachments ?? []).slice();

  // ---- EMAIL / MANUAL ----------------------------------------------------
  if (st === "EMAIL" || st === "MANUAL") {
    let bodyText: string | undefined;
    let extractedAttachments: InlineAttachment[] = [];

    if (st === "EMAIL" && req.raw_email) {
      const parsed = await parseRawEmail(req.raw_email);
      bodyText = parsed.text;
      extractedAttachments = parsed.attachments;
    } else {
      bodyText = req.document_content;
    }

    if (!bodyText) {
      return { content: "", text_proxy: "",
        error: `${st} requires document_content or raw_email` };
    }

    const allImages = [...extractedAttachments, ...callerAttachments].slice(0, MAX_INLINE_IMAGES);
    if (allImages.length === 0) {
      return { content: bodyText, text_proxy: bodyText };
    }

    const blocks: UserContentBlock[] = [{ type: "text", text: bodyText }];
    for (const att of allImages) {
      const block = attachmentToBlock(att);
      if (block) blocks.push(block);
    }
    blocks.push({
      type: "text",
      text: "The images above are inline attachments from the email body. They may show " +
            "scanned PO sheets, product photos, or screenshots — extract any PO data you " +
            "see in them and merge with the text above.",
    });
    return { content: blocks, text_proxy: bodyText, inline_images_found: allImages.length };
  }

  // ---- PDF / IMAGE / EXCEL: validate file_base64 -------------------------
  if (!req.file_base64 || !req.file_mime) {
    return { content: "", text_proxy: "", error: `${st} requires file_base64 and file_mime` };
  }

  const size = decodeBase64Size(req.file_base64);
  if (size > MAX_FILE_BYTES) {
    return { content: "", text_proxy: "", error: `file too large: ${size} bytes (max ${MAX_FILE_BYTES})` };
  }

  if (st === "PDF") {
    if (req.file_mime !== PDF_MIME) {
      return { content: "", text_proxy: "", error: `PDF source_type requires file_mime=application/pdf` };
    }
    const blocks: UserContentBlock[] = [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: req.file_base64 } },
    ];
    const extras = callerAttachments.slice(0, MAX_INLINE_IMAGES);
    for (const att of extras) {
      const block = attachmentToBlock(att);
      if (block) blocks.push(block);
    }
    blocks.push({ type: "text", text: "Extract this purchase order per the JSON schema in your system prompt." });
    return {
      content: blocks,
      text_proxy: `PDF purchase order from customer ${req.customer_id}`,
      inline_images_found: extras.length,
    };
  }

  if (st === "IMAGE") {
    if (!IMAGE_MIMES.has(req.file_mime)) {
      return { content: "", text_proxy: "", error: `IMAGE source_type requires a known image mime, got ${req.file_mime}` };
    }
    const blocks: UserContentBlock[] = [
      { type: "image", source: { type: "base64", media_type: req.file_mime, data: req.file_base64 } },
    ];
    const extras = callerAttachments.slice(0, MAX_INLINE_IMAGES - 1);
    for (const att of extras) {
      const block = attachmentToBlock(att);
      if (block) blocks.push(block);
    }
    blocks.push({ type: "text", text: "Extract this purchase order per the JSON schema in your system prompt." });
    return {
      content: blocks,
      text_proxy: `Image purchase order from customer ${req.customer_id}`,
      inline_images_found: extras.length,
    };
  }

  if (st === "EXCEL") {
    if (!XLSX_MIMES.has(req.file_mime)) {
      return { content: "", text_proxy: "", error: `EXCEL source_type requires a spreadsheet mime, got ${req.file_mime}` };
    }
    let csvText: string;
    try {
      csvText = xlsxBase64ToText(req.file_base64);
    } catch (e) {
      return { content: "", text_proxy: "", error: `xlsx parse failed: ${(e as Error).message}` };
    }
    if (!csvText) {
      return { content: "", text_proxy: "", error: "xlsx parsed to empty text" };
    }

    // Pull embedded images out of the xlsx zip (xl/media/*)
    const embedded = await extractXlsxImages(req.file_base64);
    const allImages = [...embedded, ...callerAttachments].slice(0, MAX_INLINE_IMAGES);

    if (allImages.length === 0) {
      return { content: csvText, text_proxy: csvText };
    }

    const blocks: UserContentBlock[] = [{ type: "text", text: csvText }];
    for (const att of allImages) {
      const block = attachmentToBlock(att);
      if (block) blocks.push(block);
    }
    blocks.push({
      type: "text",
      text: "The images above were embedded in cells of the spreadsheet. They may " +
            "contain product photos, scanned PO snippets, or annotations — extract " +
            "any PO data visible in them and merge with the CSV text above.",
    });
    return { content: blocks, text_proxy: csvText, inline_images_found: allImages.length };
  }

  return { content: "", text_proxy: "", error: `unsupported source_type: ${st}` };
}

async function fetchMasterArticlesForRAG(
  supabase: ReturnType<typeof createClient>,
  documentContent: string,
): Promise<MasterArticle[]> {
  // Use the same trigram RPC, but with a higher candidate cap for the few-shot prompt
  const { data, error } = await supabase.rpc("find_similar_articles", {
    query_text: documentContent.slice(0, 4000),
    match_limit: 20,
    min_similarity: 0.05,
  });
  if (error || !Array.isArray(data)) return [];
  return data as MasterArticle[];
}

async function aiReconcileSKUs(
  supabase: ReturnType<typeof createClient>,
  anthropic: Anthropic,
  items: RawExtraction["line_items"],
): Promise<Array<LineItem & {
  quantity_confidence: number;
  unit_confidence: number;
  price_confidence: number;
  match_reasoning: string;
}>> {
  // Per-line AI matching: trigram pre-filter via RPC → Claude disambiguation
  const matches = await Promise.all(
    items.map((item) =>
      matchSKU(supabase as unknown as Parameters<typeof matchSKU>[0], anthropic, {
        llm_sku: item.sku,
        description: item.description,
        llm_sku_confidence: item.sku_confidence ?? 0.5,
      })
    ),
  );

  return items.map((item, idx) => {
    const m = matches[idx];
    const llmConfidence = item.sku_confidence ?? 0.5;

    let finalSku = item.sku;
    let skuConfidence = llmConfidence;

    if (m.matched_sku) {
      finalSku = m.matched_sku;
      // Combine signals: trust the matcher's confidence, floored by extraction confidence
      skuConfidence = Math.max(m.confidence, Math.min(llmConfidence, 0.95));
    } else if (llmConfidence > 0.5) {
      // No master match found by AI: cap confidence so the line is flagged for review
      skuConfidence = Math.min(llmConfidence, 0.60);
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
      // Stash matched master for CBM resolver below
      _matched_master: m.master_article,
      match_reasoning: m.reasoning,
    } as LineItem & {
      quantity_confidence: number;
      unit_confidence: number;
      price_confidence: number;
      match_reasoning: string;
      _matched_master: MasterArticle | null;
    };
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

  if (!payload.source_type || !payload.customer_id) {
    return json({ error: "missing required fields: source_type, customer_id" }, 400);
  }

  // Build LLM input (text string or content blocks) based on source type
  const built = await buildUserContent(payload);
  if (built.error) {
    return json({ error: built.error }, 400);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const masterArticles = await fetchMasterArticlesForRAG(supabase, built.text_proxy);

  const systemPrompt = SYSTEM_PROMPT_PO_EXTRACTION + buildFewShotContext(
    masterArticles.map((m) => ({
      sku: m.sku,
      description: (m as unknown as { description?: string }).description ?? "",
      unit: m.unit ?? "",
    })),
  );

  // Tier 1: Haiku
  let extraction = await callAnthropic(anthropic, HAIKU_MODEL, systemPrompt, built.content);
  let modelUsed = HAIKU_MODEL;

  // Tier 2: Sonnet fallback on low confidence
  if (!extraction || extraction._confidence?.overall < CONFIDENCE_FALLBACK_THRESHOLD) {
    const sonnet = await callAnthropic(anthropic, SONNET_MODEL, systemPrompt, built.content);
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

  // AI-driven SKU matching (trigram pre-filter → Claude disambiguation per line)
  const reconciledItems = await aiReconcileSKUs(supabase, anthropic, extraction.line_items ?? []);

  // CBM enrichment — build lookup from the AI-matched master rows directly
  // so a matched SKU's standard_dimensions always reach the resolver.
  const masterLookup = new Map<string, MasterArticle>();
  for (const m of masterArticles) masterLookup.set(m.sku, m);
  for (const item of reconciledItems) {
    const matched = (item as unknown as { _matched_master: MasterArticle | null })._matched_master;
    if (matched) masterLookup.set(matched.sku, matched);
  }
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

  // Persist. For binary inputs we store the parsed text proxy, not the base64 blob —
  // the source file should be uploaded separately to Storage if you need it retained.
  const rawForDb = typeof built.content === "string"
    ? built.content.slice(0, 100_000)
    : `[${payload.source_type} file, ${payload.file_mime}, ~${decodeBase64Size(payload.file_base64 ?? "")} bytes]`;

  const { data: inserted, error: insertError } = await supabase
    .from("ai_extractions")
    .insert({
      kind: "purchase_order",
      customer_id: payload.customer_id,
      source_type: payload.source_type,
      raw_content: rawForDb,
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
    inline_images_processed: built.inline_images_found ?? 0,
  });
});
