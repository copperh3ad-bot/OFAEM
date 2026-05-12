// parse-po edge function
//
// Thin HTTP wrapper around _shared/extractor.ts → runExtraction().
// Accepts:
//   EMAIL / MANUAL  → { document_content: string, ... } or { raw_email: string, ... }
//   PDF             → { file_base64: string, file_mime: "application/pdf", ... }
//   IMAGE           → { file_base64: string, file_mime: "image/jpeg|png|webp", ... }
//   EXCEL           → { file_base64: string, file_mime: "application/vnd.openxml...", ... }
//
// Optional: attachments[] of additional images for any source_type.

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.30.0";

import { runExtraction, type ExtractRequest } from "../_shared/extractor.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

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

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let payload: ExtractRequest;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid json body" }, 400);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const result = await runExtraction(supabase, anthropic, payload);
  if (!result.success) {
    return json({ error: result.error }, result.status ?? 500);
  }
  return json({
    success: true,
    extraction_id: result.extraction_id,
    normalized_po: result.normalized_po,
    model_used: result.model_used,
    inline_images_processed: result.inline_images_processed,
    version: result.version,
  });
});
