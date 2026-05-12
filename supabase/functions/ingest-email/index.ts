// ingest-email edge function
//
// POST { raw_email: string, customer_id?: string, source_label?: string }
//
// Pipeline:
//   1. Parse RFC822 MIME → from, subject, body, attachments
//   2. Idempotency check on Message-ID against email_ingest_log
//   3. Classify with Claude Haiku: is this a purchase order?
//   4. If yes (confidence >= 0.65): call parse-po internally with the email body
//      and attachments (PDFs/XLSX get extracted separately)
//   5. Log to email_ingest_log with classification + extraction_id
//
// Designed to be wired to an inbound-email webhook (SendGrid Inbound Parse,
// Mailgun Routes, Postmark, AWS SES → Lambda, or your own IMAP poller forwarding
// raw .eml content).

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.30.0";
import PostalMime from "https://esm.sh/postal-mime@2.4.3";

import { classifyEmail, IS_PO_THRESHOLD, type ClassifierResult } from "../_shared/email_classifier.ts";
import { runExtraction } from "../_shared/extractor.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

const MAX_RAW_EMAIL_BYTES = 12 * 1024 * 1024;  // 12 MB headroom for attachments

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

interface IngestRequest {
  raw_email: string;
  customer_id?: string;
  source_label?: string;
}

interface ParsedEmail {
  message_id?: string;
  from_address: string;
  subject: string;
  text_body: string;
  attachments: Array<{ filename: string; mime: string; size: number; is_image: boolean }>;
  total_size: number;
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
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function parseEmail(raw: string): Promise<ParsedEmail> {
  // deno-lint-ignore no-explicit-any
  const email = await (PostalMime as any).parse(raw);
  const text = (email.text ?? stripHtml(email.html ?? "") ?? "").toString();
  const from = email.from?.address ?? email.from?.[0]?.address ?? email.from ?? "(unknown)";
  const subject = email.subject ?? "(no subject)";
  const messageId = email.messageId ?? undefined;
  const attachments: ParsedEmail["attachments"] = [];
  for (const att of email.attachments ?? []) {
    const size = (att.content as ArrayBuffer)?.byteLength ?? 0;
    attachments.push({
      filename: att.filename ?? "(unnamed)",
      mime: att.mimeType ?? "application/octet-stream",
      size,
      is_image: (att.mimeType ?? "").startsWith("image/"),
    });
  }
  return {
    message_id: messageId,
    from_address: String(from),
    subject: String(subject),
    text_body: text,
    attachments,
    total_size: raw.length,
  };
}

function attachmentSummary(parsed: ParsedEmail): string {
  if (parsed.attachments.length === 0) return "(none)";
  const counts: Record<string, number> = {};
  for (const a of parsed.attachments) {
    const cat = a.mime.startsWith("image/") ? "image"
              : a.mime === "application/pdf" ? "PDF"
              : a.mime.includes("spreadsheet") || a.mime === "application/vnd.ms-excel" ? "XLSX"
              : "other";
    counts[cat] = (counts[cat] ?? 0) + 1;
  }
  const parts = Object.entries(counts).map(([k, v]) => `${v} ${k}${v > 1 ? "s" : ""}`);
  parts.push(`(filenames: ${parsed.attachments.map(a => a.filename).join(", ").slice(0, 200)})`);
  return parts.join(", ");
}


async function logIngest(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  parsed: ParsedEmail,
  classification: ClassifierResult,
  decision: "PO" | "NOT_PO" | "SKIPPED" | "ERROR",
  extras: {
    customer_id?: string;
    extraction_id?: string | null;
    error_detail?: string;
    processing_ms: number;
  },
): Promise<void> {
  await supabase.from("email_ingest_log").insert({
    message_id: parsed.message_id ?? null,
    from_address: parsed.from_address,
    subject: parsed.subject,
    classification: decision,
    classifier_confidence: classification.confidence,
    classifier_reason: classification.reason,
    classifier_model: classification.model,
    customer_id: extras.customer_id ?? null,
    extraction_id: extras.extraction_id ?? null,
    raw_size_bytes: parsed.total_size,
    processing_ms: extras.processing_ms,
    error_detail: extras.error_detail ?? null,
  }).then(() => {}).catch(() => {});
}

function deriveCustomerId(parsed: ParsedEmail, override?: string): string {
  if (override) return override;
  // Default: use sender's email domain as customer_id so revision detection
  // groups POs from the same buyer organization
  const match = parsed.from_address.match(/@([\w.-]+)/);
  return match ? match[1].toUpperCase() : "UNKNOWN_BUYER";
}

serve(async (req: Request): Promise<Response> => {
  const startedAt = Date.now();
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let payload: IngestRequest;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid json body" }, 400);
  }
  if (!payload.raw_email) {
    return json({ error: "raw_email is required" }, 400);
  }
  if (payload.raw_email.length > MAX_RAW_EMAIL_BYTES) {
    return json({ error: `raw_email too large (${payload.raw_email.length} bytes)` }, 413);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  // Parse MIME
  let parsed: ParsedEmail;
  try {
    parsed = await parseEmail(payload.raw_email);
  } catch (e) {
    return json({ error: `email parse failed: ${(e as Error).message}` }, 400);
  }

  // Idempotency: have we seen this Message-ID before?
  if (parsed.message_id) {
    const { data: existing } = await supabase
      .from("email_ingest_log")
      .select("id, classification, extraction_id")
      .eq("message_id", parsed.message_id)
      .maybeSingle();
    if (existing) {
      return json({
        success: true,
        skipped: true,
        reason: "duplicate_message_id",
        prior_log_id: existing.id,
        prior_classification: existing.classification,
        prior_extraction_id: existing.extraction_id,
      });
    }
  }

  const customerId = deriveCustomerId(parsed, payload.customer_id);

  // Classify
  const classification = await classifyEmail(anthropic, {
    from_address: parsed.from_address,
    subject: parsed.subject,
    body_excerpt: parsed.text_body,
    attachment_summary: attachmentSummary(parsed),
  });

  if (!classification.is_purchase_order || classification.confidence < IS_PO_THRESHOLD) {
    await logIngest(supabase, parsed, classification, "NOT_PO", {
      customer_id: customerId, processing_ms: Date.now() - startedAt,
    });
    return json({
      success: true,
      classification: "NOT_PO",
      confidence: classification.confidence,
      reason: classification.reason,
    });
  }

  // It's a PO — run extraction in-process (no internal HTTP, no auth handshake)
  const result = await runExtraction(supabase, anthropic, {
    source_type: "EMAIL",
    customer_id: customerId,
    raw_email: payload.raw_email,
  });

  if (!result.success) {
    await logIngest(supabase, parsed, classification, "ERROR", {
      customer_id: customerId,
      error_detail: result.error ?? "unknown",
      processing_ms: Date.now() - startedAt,
    });
    return json({
      success: false,
      classification: "PO",
      confidence: classification.confidence,
      error: "extraction_failed",
      detail: result.error,
    }, result.status ?? 502);
  }

  await logIngest(supabase, parsed, classification, "PO", {
    customer_id: customerId,
    extraction_id: result.extraction_id,
    processing_ms: Date.now() - startedAt,
  });

  return json({
    success: true,
    classification: "PO",
    confidence: classification.confidence,
    reason: classification.reason,
    customer_id: customerId,
    extraction_id: result.extraction_id,
    normalized_po: result.normalized_po,
    version: result.version,
    inline_images_processed: result.inline_images_processed,
  });
});
