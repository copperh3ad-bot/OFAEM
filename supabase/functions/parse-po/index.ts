// parse-po edge function
//
// Thin HTTP wrapper around _shared/extractor.ts → runExtraction().
// Adds per-request metrics + rate limiting.

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.30.0";

import { runExtraction, type ExtractRequest } from "../_shared/extractor.ts";
import { MetricsRecorder } from "../_shared/metrics.ts";
import { applyRateLimit, rateLimitResponse } from "../_shared/rate_limit.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

// Per-caller rate limit: 30 extractions per 60-second window
const RL_MAX = 30;
const RL_WINDOW_SECS = 60;

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

function callerBucketKey(req: Request, customerId: string | undefined): string {
  // Prefer the auth.uid embedded in the JWT (so per-user limits are real).
  // Fall back to customer_id, then a generic anonymous bucket.
  const auth = req.headers.get("Authorization") ?? "";
  const jwt = auth.replace(/^Bearer\s+/i, "");
  try {
    const parts = jwt.split(".");
    if (parts.length === 3) {
      const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/")
        + "===".slice((parts[1].length + 3) % 4);
      const claims = JSON.parse(atob(payload));
      if (claims.sub) return `parse-po:user:${claims.sub}`;
      if (claims.role) return `parse-po:role:${claims.role}`;
    }
  } catch { /* fall through */ }
  if (customerId) return `parse-po:customer:${customerId}`;
  return `parse-po:anon`;
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
  const metrics = new MetricsRecorder("parse-po");

  // Rate limit
  const rl = await applyRateLimit(supabase, {
    key: callerBucketKey(req, payload.customer_id),
    max: RL_MAX,
    window_seconds: RL_WINDOW_SECS,
  });
  if (!rl.allowed) {
    await metrics.flush(supabase, "failure", {
      source_type: payload.source_type, customer_id: payload.customer_id,
      error_code: "rate_limit_exceeded",
      metadata: { current_count: rl.current_count },
    });
    return rateLimitResponse(rl);
  }

  const result = await runExtraction(supabase, anthropic, payload, metrics);

  if (!result.success) {
    await metrics.flush(supabase, "failure", {
      source_type: payload.source_type,
      customer_id: payload.customer_id,
      error_code: result.error ?? "unknown",
    });
    return json({ error: result.error }, result.status ?? 500);
  }

  await metrics.flush(supabase, "success", {
    source_type: payload.source_type,
    customer_id: payload.customer_id,
    extraction_id: result.extraction_id,
    metadata: {
      model_used: result.model_used,
      line_items: (result.normalized_po?.line_items as unknown[] | undefined)?.length ?? 0,
      is_revision: result.version?.is_revision,
      inline_images: result.inline_images_processed,
    },
  });

  return json({
    success: true,
    extraction_id: result.extraction_id,
    normalized_po: result.normalized_po,
    model_used: result.model_used,
    inline_images_processed: result.inline_images_processed,
    version: result.version,
  });
});
