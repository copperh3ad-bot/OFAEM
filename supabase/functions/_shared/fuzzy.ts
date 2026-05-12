/**
 * Token-set fuzzy match — Deno port of fuzzywuzzy's token_set_ratio.
 * Used to reconcile LLM-extracted SKUs against the master catalog.
 */

function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : Math.min(prev, dp[j], dp[j - 1]) + 1;
      prev = tmp;
    }
  }
  return dp[b.length];
}

function ratio(a: string, b: string): number {
  if (!a && !b) return 100;
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return Math.round((1 - dist / maxLen) * 100);
}

export function tokenSetRatio(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  const intersection = [...ta].filter((t) => tb.has(t)).sort().join(" ");
  const diffA = [...ta].filter((t) => !tb.has(t)).sort().join(" ");
  const diffB = [...tb].filter((t) => !ta.has(t)).sort().join(" ");
  const t1 = intersection;
  const t2 = (intersection + " " + diffA).trim();
  const t3 = (intersection + " " + diffB).trim();
  return Math.max(ratio(t1, t2), ratio(t1, t3), ratio(t2, t3));
}

export interface FuzzyMatch {
  sku: string;
  score: number;
}

export function bestMatch(
  candidate: string,
  candidateDescription: string,
  master: Array<{ sku: string; description: string }>,
  minScore = 70,
): FuzzyMatch | null {
  let best: FuzzyMatch | null = null;
  for (const row of master) {
    const score = Math.max(
      tokenSetRatio(candidate, row.sku),
      tokenSetRatio(candidateDescription, row.description),
    );
    if (score >= minScore && (!best || score > best.score)) {
      best = { sku: row.sku, score };
    }
  }
  return best;
}
