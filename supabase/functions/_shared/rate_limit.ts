/**
 * Per-request rate limiting backed by Postgres `check_rate_limit` RPC.
 *
 * Usage:
 *   const limit = await applyRateLimit(supabase, {
 *     key: `parse-po:${callerId}`,
 *     max: 30,
 *     window_seconds: 60,
 *   });
 *   if (!limit.allowed) return rateLimitResponse(limit);
 *
 * The key should be specific enough to isolate noisy callers without lumping
 * all anonymous traffic into one bucket. Suggested patterns:
 *   parse-po:user:<auth.uid>
 *   ingest-email:from_domain:<domain>
 *   render-proforma:user:<auth.uid>
 *
 * Failures of the RPC itself default to ALLOW (fail-open) — we'd rather
 * over-serve than block legitimate traffic when Postgres is degraded.
 */

export interface RateLimitResult {
  allowed: boolean;
  current_count: number;
  resets_at: string;       // ISO timestamp
  retry_after_seconds: number;
}

export async function applyRateLimit(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  opts: { key: string; max: number; window_seconds: number },
): Promise<RateLimitResult> {
  try {
    const { data, error } = await supabase.rpc("check_rate_limit", {
      p_key: opts.key,
      p_max_per_window: opts.max,
      p_window_seconds: opts.window_seconds,
    });
    if (error || !Array.isArray(data) || data.length === 0) {
      // Fail-open
      return { allowed: true, current_count: 0, resets_at: new Date().toISOString(), retry_after_seconds: 0 };
    }
    const row = data[0] as { allowed: boolean; current_count: number; resets_at: string };
    const resetsAt = new Date(row.resets_at);
    const retryAfter = Math.max(0, Math.ceil((resetsAt.getTime() - Date.now()) / 1000));
    return {
      allowed: row.allowed,
      current_count: row.current_count,
      resets_at: row.resets_at,
      retry_after_seconds: retryAfter,
    };
  } catch {
    return { allowed: true, current_count: 0, resets_at: new Date().toISOString(), retry_after_seconds: 0 };
  }
}

export function rateLimitResponse(result: RateLimitResult): Response {
  return new Response(
    JSON.stringify({
      error: "rate_limit_exceeded",
      current_count: result.current_count,
      resets_at: result.resets_at,
      retry_after_seconds: result.retry_after_seconds,
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(result.retry_after_seconds),
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}
