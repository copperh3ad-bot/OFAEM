/**
 * Per-request metrics recorder.
 *
 * Each edge function instantiates one MetricsRecorder at entry, records LLM
 * call usage as it goes, then flushes a single pipeline_metrics row before
 * returning. The recorder is best-effort: a failed flush does NOT propagate
 * an exception (we don't want to crash a successful PO over a metric write).
 *
 * Cost estimation uses Anthropic public list pricing as of 2026-05 — adjust
 * when pricing changes. Cache hits / writes not currently tracked separately;
 * folded into input_tokens.
 */

const COST_PER_M_TOKENS_USD: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5-20251001":  { in: 1.00, out:  5.00 },
  "claude-sonnet-4-6":          { in: 3.00, out: 15.00 },
  "claude-opus-4-7":            { in: 15.00, out: 75.00 },
};

interface LLMCall {
  model: string;
  input_tokens: number;
  output_tokens: number;
}

export class MetricsRecorder {
  private started_at_ms: number;
  private llm_calls: LLMCall[] = [];

  constructor(public readonly function_name: string) {
    this.started_at_ms = Date.now();
  }

  /** Record one Anthropic messages.create round trip. */
  recordLLMCall(model: string, usage: { input_tokens?: number; output_tokens?: number } | null | undefined): void {
    if (!usage) return;
    this.llm_calls.push({
      model,
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
    });
  }

  private totalCostUsd(): number {
    let cost = 0;
    for (const c of this.llm_calls) {
      const rate = COST_PER_M_TOKENS_USD[c.model];
      if (!rate) continue;
      cost += (c.input_tokens / 1_000_000) * rate.in
           +  (c.output_tokens / 1_000_000) * rate.out;
    }
    return Math.round(cost * 1_000_000) / 1_000_000;  // 6dp
  }

  totals(): { calls: number; in_tokens: number; out_tokens: number; cost_usd: number } {
    return {
      calls: this.llm_calls.length,
      in_tokens: this.llm_calls.reduce((s, c) => s + c.input_tokens, 0),
      out_tokens: this.llm_calls.reduce((s, c) => s + c.output_tokens, 0),
      cost_usd: this.totalCostUsd(),
    };
  }

  /** Best-effort flush. Failures are swallowed and logged to console only. */
  async flush(
    // deno-lint-ignore no-explicit-any
    supabase: any,
    status: "success" | "failure" | "partial",
    extras: {
      source_type?: string | null;
      customer_id?: string | null;
      extraction_id?: string | null;
      error_code?: string | null;
      metadata?: Record<string, unknown>;
    } = {},
  ): Promise<void> {
    const duration_ms = Date.now() - this.started_at_ms;
    const t = this.totals();
    try {
      const { error } = await supabase.from("pipeline_metrics").insert({
        function_name: this.function_name,
        status,
        duration_ms,
        llm_calls: t.calls,
        llm_input_tokens: t.in_tokens,
        llm_output_tokens: t.out_tokens,
        estimated_cost_usd: t.cost_usd,
        source_type: extras.source_type ?? null,
        customer_id: extras.customer_id ?? null,
        extraction_id: extras.extraction_id ?? null,
        error_code: extras.error_code ?? null,
        metadata: extras.metadata ?? null,
      });
      if (error) console.error(`[metrics flush] ${this.function_name}:`, error.message);
    } catch (e) {
      console.error(`[metrics flush] ${this.function_name} threw:`, (e as Error).message);
    }
  }
}
