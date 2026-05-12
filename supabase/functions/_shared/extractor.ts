/**
 * PO extraction orchestrator.
 *
 * Pure async function (no HTTP): given a Supabase service-role client, an
 * Anthropic client, and an ExtractRequest, returns either a normalized PO
 * + extraction_id + revision metadata, or an error.
 *
 * Called by both the parse-po edge function (HTTP wrapper) and the
 * ingest-email edge function (in-process, no internal HTTP).
 */

import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.30.0";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import JSZip from "https://esm.sh/jszip@3.10.1";
import PostalMime from "https://esm.sh/postal-mime@2.4.3";

import { calculateCBM, type LineItem, type MasterArticle } from "./cbm.ts";
import { applyReadinessFlags } from "./confidence.ts";
import { matchSKU } from "./sku_matcher.ts";
import { computePayloadDiff, type RevisionDiff } from "./revision_detector.ts";
import {
  SYSTEM_PROMPT_PO_EXTRACTION,
  buildFewShotContext,
  PARSING_PIPELINE_VERSION,
} from "./prompts.ts";
import { withRetry } from "./retry.ts";
import { pLimit } from "./concurrency.ts";
import {
  INJECTION_GUARD_SYSTEM_LINE,
  wrapUntrusted,
  validateMetadata,
  validateLineItem,
} from "./safety.ts";
import { MetricsRecorder } from "./metrics.ts";

const MATCHER_CONCURRENCY = 5;

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const SONNET_MODEL = "claude-sonnet-4-6";
const LLM_TIMEOUT_MS = 120_000;
const CONFIDENCE_FALLBACK_THRESHOLD = 0.70;
const MAX_TOKENS = 8192;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_INLINE_IMAGES = 6;

const PDF_MIME = "application/pdf";
const IMAGE_MIMES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"]);
const XLSX_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);

export interface InlineAttachment {
  file_base64: string;
  file_mime: string;
  filename?: string;
}

export interface ExtractRequest {
  source_type: "PDF" | "IMAGE" | "EXCEL" | "EMAIL" | "MANUAL";
  customer_id: string;
  document_content?: string;
  raw_email?: string;
  file_base64?: string;
  file_mime?: string;
  attachments?: InlineAttachment[];
}

export interface ExtractResponse {
  success: boolean;
  status?: number;
  error?: string;
  extraction_id?: string;
  normalized_po?: Record<string, unknown>;
  model_used?: string;
  inline_images_processed?: number;
  version?: {
    is_revision: boolean;
    version_number: number;
    superseded_extraction_ids: string[];
    diff: RevisionDiff | null;
  };
}

// Internal fields stripped from line_items before payload persistence so they
// never reach buyer-readable rows. (match_reasoning and _matched_master are
// matcher debug metadata — useful in the immediate API response but should
// not be stored or exposed via ai_extractions.payload.)
const INTERNAL_LINE_ITEM_FIELDS = new Set(["_matched_master", "match_reasoning"]);
function stripInternal<T extends Record<string, unknown>>(items: T[]): T[] {
  return items.map((it) => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(it)) {
      if (!INTERNAL_LINE_ITEM_FIELDS.has(k)) out[k] = it[k];
    }
    return out as T;
  });
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

// ── helpers ─────────────────────────────────────────────────────────────────

function decodeBase64Size(b64: string): number {
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

function bytesToBase64(bytes: Uint8Array): string {
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
    default:     return null;
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n").trim();
}

function xlsxBase64ToText(b64: string): string {
  const bytes = decodeBase64ToBytes(b64);
  const wb = XLSX.read(bytes, { type: "array" });
  const sheets: string[] = [];
  for (const sheetName of wb.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheetName], { blankrows: false });
    if (csv.trim()) sheets.push(`--- Sheet: ${sheetName} ---\n${csv}`);
  }
  return sheets.join("\n\n");
}

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

async function parseRawEmail(raw: string): Promise<{ text: string; attachments: InlineAttachment[] }> {
  try {
    // deno-lint-ignore no-explicit-any
    const email = await (PostalMime as any).parse(raw);
    const text = (email.text ?? stripHtml(email.html ?? "") ?? "").toString();
    const attachments: InlineAttachment[] = [];
    for (const att of email.attachments ?? []) {
      const mime: string = att.mimeType ?? "";
      if (!mime.startsWith("image/")) continue;
      const bytes = new Uint8Array(att.content as ArrayBuffer);
      attachments.push({ file_base64: bytesToBase64(bytes), file_mime: mime, filename: att.filename ?? undefined });
    }
    return { text, attachments };
  } catch (_e) {
    return { text: raw, attachments: [] };
  }
}

function attachmentToBlock(att: InlineAttachment): UserContentBlock | null {
  if (!IMAGE_MIMES.has(att.file_mime)) return null;
  return { type: "image", source: { type: "base64", media_type: att.file_mime, data: att.file_base64 } };
}

async function buildUserContent(req: ExtractRequest): Promise<{
  content: string | UserContentBlock[];
  text_proxy: string;
  error?: string;
  inline_images_found?: number;
}> {
  const st = req.source_type;
  const callerAttachments = (req.attachments ?? []).slice();

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
    if (!bodyText) return { content: "", text_proxy: "", error: `${st} requires document_content or raw_email` };

    // Wrap buyer-controlled text in delimiters the system prompt is told to ignore as instructions
    const wrappedBody = wrapUntrusted("buyer_document", bodyText);

    const allImages = [...extractedAttachments, ...callerAttachments].slice(0, MAX_INLINE_IMAGES);
    if (allImages.length === 0) return { content: wrappedBody, text_proxy: bodyText };

    const blocks: UserContentBlock[] = [{ type: "text", text: wrappedBody }];
    for (const att of allImages) { const b = attachmentToBlock(att); if (b) blocks.push(b); }
    blocks.push({ type: "text",
      text: "The images above are inline attachments from the email body. They may show scanned PO sheets, " +
            "product photos, or screenshots — extract any PO data you see in them and merge with the text above." });
    return { content: blocks, text_proxy: bodyText, inline_images_found: allImages.length };
  }

  if (!req.file_base64 || !req.file_mime) {
    return { content: "", text_proxy: "", error: `${st} requires file_base64 and file_mime` };
  }
  const size = decodeBase64Size(req.file_base64);
  if (size > MAX_FILE_BYTES) {
    return { content: "", text_proxy: "", error: `file too large: ${size} bytes (max ${MAX_FILE_BYTES})` };
  }

  if (st === "PDF") {
    if (req.file_mime !== PDF_MIME) return { content: "", text_proxy: "", error: `PDF requires application/pdf mime` };
    const blocks: UserContentBlock[] = [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: req.file_base64 } },
    ];
    const extras = callerAttachments.slice(0, MAX_INLINE_IMAGES);
    for (const att of extras) { const b = attachmentToBlock(att); if (b) blocks.push(b); }
    blocks.push({ type: "text", text: "Extract this purchase order per the JSON schema in your system prompt." });
    return { content: blocks, text_proxy: `PDF purchase order from customer ${req.customer_id}`, inline_images_found: extras.length };
  }

  if (st === "IMAGE") {
    if (!IMAGE_MIMES.has(req.file_mime)) {
      return { content: "", text_proxy: "", error: `IMAGE requires a known image mime, got ${req.file_mime}` };
    }
    const blocks: UserContentBlock[] = [
      { type: "image", source: { type: "base64", media_type: req.file_mime, data: req.file_base64 } },
    ];
    const extras = callerAttachments.slice(0, MAX_INLINE_IMAGES - 1);
    for (const att of extras) { const b = attachmentToBlock(att); if (b) blocks.push(b); }
    blocks.push({ type: "text", text: "Extract this purchase order per the JSON schema in your system prompt." });
    return { content: blocks, text_proxy: `Image purchase order from customer ${req.customer_id}`, inline_images_found: extras.length };
  }

  if (st === "EXCEL") {
    if (!XLSX_MIMES.has(req.file_mime)) {
      return { content: "", text_proxy: "", error: `EXCEL requires a spreadsheet mime, got ${req.file_mime}` };
    }
    let csvText: string;
    try { csvText = xlsxBase64ToText(req.file_base64); }
    catch (e) { return { content: "", text_proxy: "", error: `xlsx parse failed: ${(e as Error).message}` }; }
    if (!csvText) return { content: "", text_proxy: "", error: "xlsx parsed to empty text" };

    const wrappedCsv = wrapUntrusted("buyer_document", csvText);

    const embedded = await extractXlsxImages(req.file_base64);
    const allImages = [...embedded, ...callerAttachments].slice(0, MAX_INLINE_IMAGES);
    if (allImages.length === 0) return { content: wrappedCsv, text_proxy: csvText };

    const blocks: UserContentBlock[] = [{ type: "text", text: wrappedCsv }];
    for (const att of allImages) { const b = attachmentToBlock(att); if (b) blocks.push(b); }
    blocks.push({ type: "text",
      text: "The images above were embedded in cells of the spreadsheet. They may contain product photos, " +
            "scanned PO snippets, or annotations — extract any PO data visible in them and merge with the CSV text above." });
    return { content: blocks, text_proxy: csvText, inline_images_found: allImages.length };
  }

  return { content: "", text_proxy: "", error: `unsupported source_type: ${st}` };
}

async function callAnthropic(
  client: Anthropic,
  model: string,
  systemPrompt: string,
  userContent: string | UserContentBlock[],
  metrics?: MetricsRecorder,
): Promise<RawExtraction | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), LLM_TIMEOUT_MS);
  try {
    const resp = await withRetry(() => client.messages.create(
      {
        model, max_tokens: MAX_TOKENS, system: systemPrompt,
        messages: [{ role: "user", content: userContent as unknown as string }],
      },
      { signal: ctl.signal },
    ));
    metrics?.recordLLMCall(model, resp.usage);
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

// deno-lint-ignore no-explicit-any
async function fetchMasterArticlesForRAG(supabase: any, textProxy: string): Promise<MasterArticle[]> {
  const { data, error } = await supabase.rpc("find_similar_articles", {
    query_text: textProxy.slice(0, 4000),
    match_limit: 20,
    min_similarity: 0.05,
  });
  if (error || !Array.isArray(data)) return [];
  return data as MasterArticle[];
}

async function aiReconcileSKUs(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  anthropic: Anthropic,
  items: RawExtraction["line_items"],
): Promise<Array<LineItem & {
  quantity_confidence: number; unit_confidence: number; price_confidence: number;
  match_reasoning: string; _matched_master: MasterArticle | null;
}>> {
  // Bound concurrency so a 50-line PO doesn't fire 50 simultaneous Anthropic calls
  const limit = pLimit(MATCHER_CONCURRENCY);
  const matches = await Promise.all(items.map((item) => limit(() =>
    matchSKU(supabase, anthropic, {
      llm_sku: item.sku, description: item.description, llm_sku_confidence: item.sku_confidence ?? 0.5,
    }))));

  return items.map((item, idx) => {
    const m = matches[idx];
    const llmConfidence = item.sku_confidence ?? 0.5;
    let finalSku = item.sku;
    let skuConfidence = llmConfidence;
    if (m.matched_sku) {
      finalSku = m.matched_sku;
      skuConfidence = Math.max(m.confidence, Math.min(llmConfidence, 0.95));
    } else if (llmConfidence > 0.5) {
      skuConfidence = Math.min(llmConfidence, 0.60);
    }
    return {
      line_no: item.line_no ?? idx + 1,
      sku: finalSku, description: item.description, quantity: item.quantity,
      unit: item.unit, unit_price: item.unit_price, dimensions: item.dimensions ?? null,
      sku_confidence: skuConfidence,
      quantity_confidence: item.quantity_confidence ?? 0.9,
      unit_confidence: item.unit_confidence ?? 0.9,
      price_confidence: item.price_confidence ?? 0.9,
      _matched_master: m.master_article,
      match_reasoning: m.reasoning,
    } as LineItem & {
      quantity_confidence: number; unit_confidence: number; price_confidence: number;
      match_reasoning: string; _matched_master: MasterArticle | null;
    };
  });
}

// deno-lint-ignore no-explicit-any
async function logLowConfidenceFields(supabase: any, poId: string, sourceType: string, items: LineItem[]): Promise<void> {
  const rows: Array<Record<string, unknown>> = [];
  for (const item of items) {
    if (!item.requires_review) continue;
    for (const reason of (item.review_reason ?? "").split(",").filter(Boolean)) {
      // Map reason → affected_field so error_patterns trigger aggregates meaningfully
      const affectedField =
        reason === "low_sku_confidence"      ? "sku"      :
        reason === "low_quantity_confidence" ? "quantity" :
        reason === "low_unit_confidence"     ? "unit"     :
        reason === "low_price_confidence"    ? "unit_price" :
        reason === "estimated_dimensions"    ? "dimensions" :
        "unknown";
      rows.push({
        message: `Line ${item.line_no} flagged: ${reason}`,
        severity: "warning",
        category: "extraction",
        affected_field: affectedField,
        reason_code: reason,
        source_type: sourceType,
        context: JSON.stringify({ po_id: poId, line_no: item.line_no, reason }),
      });
    }
  }
  if (rows.length === 0) return;
  await supabase.from("error_log").insert(rows);
}

// ── public entry point ─────────────────────────────────────────────────────

export async function runExtraction(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  anthropic: Anthropic,
  request: ExtractRequest,
  metrics?: MetricsRecorder,
): Promise<ExtractResponse> {
  if (!request.source_type || !request.customer_id) {
    return { success: false, status: 400, error: "missing required fields: source_type, customer_id" };
  }

  const built = await buildUserContent(request);
  if (built.error) return { success: false, status: 400, error: built.error };

  const masterArticles = await fetchMasterArticlesForRAG(supabase, built.text_proxy);

  const systemPrompt = SYSTEM_PROMPT_PO_EXTRACTION
    + "\n\n" + INJECTION_GUARD_SYSTEM_LINE
    + buildFewShotContext(
      masterArticles.map((m) => ({
        sku: m.sku,
        description: (m as unknown as { description?: string }).description ?? "",
        unit: m.unit ?? "",
      })),
    );

  let extraction = await callAnthropic(anthropic, HAIKU_MODEL, systemPrompt, built.content, metrics);
  let modelUsed = HAIKU_MODEL;
  if (!extraction || extraction._confidence?.overall < CONFIDENCE_FALLBACK_THRESHOLD) {
    const sonnet = await callAnthropic(anthropic, SONNET_MODEL, systemPrompt, built.content, metrics);
    if (sonnet) { extraction = sonnet; modelUsed = SONNET_MODEL; }
  }

  if (!extraction) {
    await supabase.from("error_log").insert({
      message: "LLM extraction returned no parseable JSON",
      severity: "error", category: "extraction",
      context: JSON.stringify({ customer_id: request.customer_id, source_type: request.source_type }),
    });
    return { success: false, status: 502, error: "extraction failed" };
  }

  const reconciledItems = await aiReconcileSKUs(supabase, anthropic, extraction.line_items ?? []);

  // Post-extraction enum validation: catch hallucinated currencies / units /
  // negative quantities BEFORE they reach downstream systems.
  const metaCheck = validateMetadata({
    currency: extraction.metadata?.currency as string | undefined,
    payment_method: extraction.metadata?.payment_method as string | null | undefined,
  });
  const validatedItems = reconciledItems.map((it) => validateLineItem(it).cleaned);

  const masterLookup = new Map<string, MasterArticle>();
  for (const m of masterArticles) masterLookup.set(m.sku, m);
  for (const item of validatedItems) {
    const matched = (item as unknown as { _matched_master: MasterArticle | null })._matched_master;
    if (matched) masterLookup.set(matched.sku, matched);
  }
  const enriched = calculateCBM(validatedItems, masterLookup);
  const readiness = applyReadinessFlags(enriched, 0);
  const totalValue = readiness.items.reduce((s, i) => s + (i.quantity * i.unit_price), 0);
  const totalCBM = readiness.items.reduce((s, i) => s + (i.cbm ?? 0), 0);

  const normalized = {
    metadata: {
      po_id: String(extraction.metadata?.po_id ?? `AUTO-${Date.now()}`),
      po_date: extraction.metadata?.po_date ?? null,
      customer_id: request.customer_id,
      currency: metaCheck.cleaned_currency,
      source_document_type: request.source_type,
      payment_method: metaCheck.cleaned_payment_method,
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

  const rawForDb = typeof built.content === "string"
    ? built.content.slice(0, 100_000)
    : `[${request.source_type} file, ${request.file_mime}, ~${decodeBase64Size(request.file_base64 ?? "")} bytes]`;

  // Reject empty extractions — an "empty PO" is almost always a misclassified
  // email or a failed parse, not a legitimate zero-line order.
  if ((normalized.line_items as unknown[]).length === 0) {
    await supabase.from("error_log").insert({
      message: "extraction yielded zero line items",
      severity: "warning",
      category: "extraction",
      source_type: request.source_type,
      context: JSON.stringify({ customer_id: request.customer_id, po_id: normalized.metadata.po_id }),
    });
    return { success: false, status: 422, error: "no line items extracted" };
  }

  // Atomic insert + revision supersede via RPC (advisory xact lock prevents
  // the TOCTOU race that allowed duplicate is_current_version=true rows).
  // Internal matcher fields are stripped from the persisted payload.
  const persistedPayload = {
    ...normalized,
    line_items: stripInternal(normalized.line_items as unknown as Record<string, unknown>[]),
  };

  const { data: rpcData, error: rpcError } = await supabase.rpc("upsert_extraction_versioned", {
    p_customer_id: request.customer_id,
    p_source_type: request.source_type,
    p_raw_content: rawForDb,
    p_payload: persistedPayload,
    p_model_used: modelUsed,
    p_overall_confidence: extraction._confidence?.overall ?? null,
    p_is_ready_for_invoicing: readiness.is_ready_for_invoicing,
  });

  if (rpcError || !Array.isArray(rpcData) || rpcData.length === 0) {
    return {
      success: false, status: 500,
      error: `db upsert failed: ${rpcError?.message ?? "no rows returned"}`,
    };
  }
  const row = rpcData[0] as {
    new_extraction_id: string;
    assigned_version_number: number;
    superseded_ids: string[] | null;
    prior_payload: Record<string, unknown> | null;
    is_revision: boolean;
  };

  // Compute diff client-side from the prior payload returned by the RPC
  let diff: RevisionDiff | null = null;
  if (row.is_revision && row.prior_payload) {
    diff = computePayloadDiff(
      {
        id: (row.superseded_ids ?? [])[0] ?? "",
        version_number: row.assigned_version_number - 1,
        payload: row.prior_payload as Parameters<typeof computePayloadDiff>[0]["payload"],
      },
      persistedPayload as unknown as Parameters<typeof computePayloadDiff>[1],
    );
    // Persist the diff (non-critical UPDATE; pipeline continues if it fails)
    await supabase
      .from("ai_extractions")
      .update({ revision_diff: diff })
      .eq("id", row.new_extraction_id);
  }

  await logLowConfidenceFields(supabase, normalized.metadata.po_id, request.source_type, readiness.items);

  // Surface metadata-validation warnings (invalid currency / payment terms) to error_log
  if (metaCheck.warnings.length > 0) {
    await supabase.from("error_log").insert(
      metaCheck.warnings.map((w) => ({
        message: `Metadata field "${w.field}" outside allowed enum (original: ${JSON.stringify(w.original)}) — replaced with default`,
        severity: "warning",
        category: "extraction",
        affected_field: w.field,
        reason_code: w.reason,
        source_type: request.source_type,
        context: JSON.stringify({ po_id: normalized.metadata.po_id, original: w.original }),
      }))
    );
  }

  return {
    success: true,
    extraction_id: row.new_extraction_id,
    normalized_po: normalized,
    model_used: modelUsed,
    inline_images_processed: built.inline_images_found ?? 0,
    version: {
      is_revision: row.is_revision,
      version_number: row.assigned_version_number,
      superseded_extraction_ids: row.superseded_ids ?? [],
      diff,
    },
  };
}
