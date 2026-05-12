/**
 * Generic retry-with-backoff helper for transient upstream failures.
 *
 * Anthropic returns 429 (rate-limit), 529 (overloaded), and occasional 5xx
 * on heavy load. A single-shot LLM call killed by one of these used to fail
 * the entire PO pipeline; this helper wraps the call so transient errors
 * get up to N retries with exponential backoff + jitter.
 *
 * Timeouts (AbortError) are NOT retried — the caller already chose a budget.
 */

export interface RetryOptions {
  maxAttempts?: number;     // total attempts including the first; default 3
  baseDelayMs?: number;     // exponent base; default 800
  jitterMs?: number;        // random 0..jitterMs added to each delay; default 200
  shouldRetry?: (err: unknown) => boolean;
}

function defaultShouldRetry(err: unknown): boolean {
  // deno-lint-ignore no-explicit-any
  const e = err as any;
  const status: number | undefined = e?.status ?? e?.statusCode ?? e?.response?.status;
  if (typeof status === "number") {
    if (status === 429) return true;
    if (status === 529) return true;            // Anthropic-specific overload
    if (status >= 500 && status < 600) return true;
    return false;
  }
  // Treat connection-reset / network errors as retryable
  const code: string | undefined = e?.code;
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EPIPE") return true;
  // Anthropic SDK sometimes throws an `APIConnectionError` class name
  if (e?.name === "APIConnectionError" || e?.name === "APIError") return true;
  // Explicit timeouts (AbortController) should NOT retry
  if (e?.name === "AbortError") return false;
  return false;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const base = opts.baseDelayMs ?? 800;
  const jitter = opts.jitterMs ?? 200;
  const shouldRetry = opts.shouldRetry ?? defaultShouldRetry;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts || !shouldRetry(err)) break;
      const delay = base * Math.pow(2, attempt - 1) + Math.floor(Math.random() * jitter);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
