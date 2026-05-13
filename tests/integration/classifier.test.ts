// Classifier corpus test.
//
// For every email under tests/fixtures/emails/po/ and tests/fixtures/emails/not_po/
// this test calls the live ingest-email edge function. It asserts:
//   - PO corpus    → classification == "PO"     AND confidence >= 0.65
//   - NOT_PO corpus → classification == "NOT_PO" AND confidence <  0.50
//
// We rely on the function's idempotency dedupe (Message-ID) to avoid creating
// duplicate ai_extractions when the same fixture is re-run during dev — the
// classifier still produces a confidence score on the dedupe path (just
// returns "skipped" with prior classification, which is what we check).
//
// Env vars required (skipped if absent):
//   SUPABASE_URL         default https://ouxnplyjzlbhmvpcvjmx.supabase.co
//   SUPABASE_ANON_KEY
//
// Run:
//   SUPABASE_ANON_KEY=eyJ... deno test --allow-env --allow-net --allow-read tests/integration/classifier.test.ts

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "https://ouxnplyjzlbhmvpcvjmx.supabase.co";
const ANON = Deno.env.get("SUPABASE_ANON_KEY");
const INGEST_SECRET = Deno.env.get("INGEST_WEBHOOK_SECRET");

const PO_DIR = new URL("../fixtures/emails/po/", import.meta.url).pathname;
const NOT_PO_DIR = new URL("../fixtures/emails/not_po/", import.meta.url).pathname;

const PO_MIN_CONFIDENCE = 0.65;
const NOT_PO_MAX_CONFIDENCE = 0.50;

interface IngestResponse {
  success: boolean;
  skipped?: boolean;
  classification?: "PO" | "NOT_PO" | "ERROR" | "SKIPPED";
  confidence?: number;
  prior_classification?: string;
  reason?: string;
  error?: string;
}

async function postEmail(eml: string): Promise<IngestResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${ANON}`,
    "apikey": ANON!,
  };
  if (INGEST_SECRET) headers["X-Webhook-Secret"] = INGEST_SECRET;
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/ingest-email`, {
    method: "POST",
    headers,
    body: JSON.stringify({ raw_email: eml }),
  });
  return (await resp.json()) as IngestResponse;
}

async function listEml(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && entry.name.endsWith(".eml")) out.push(entry.name);
  }
  return out.sort();
}

const skip = !ANON;
const poFiles = skip ? [] : await listEml(PO_DIR);
const notPoFiles = skip ? [] : await listEml(NOT_PO_DIR);

for (const file of poFiles) {
  Deno.test({
    name: `[classifier:PO] ${file} should classify as PO (conf >= ${PO_MIN_CONFIDENCE})`,
    ignore: skip,
    async fn() {
      const eml = await Deno.readTextFile(`${PO_DIR}${file}`);
      const r = await postEmail(eml);
      const cls = r.prior_classification ?? r.classification;
      const conf = r.confidence ?? -1;
      if (cls !== "PO" || conf < PO_MIN_CONFIDENCE) {
        throw new Error(`Expected PO with conf >= ${PO_MIN_CONFIDENCE}; got ${cls} @ ${conf}. Body: ${JSON.stringify(r).slice(0, 400)}`);
      }
    },
  });
}

for (const file of notPoFiles) {
  Deno.test({
    name: `[classifier:NOT_PO] ${file} should classify as NOT_PO (conf <= ${NOT_PO_MAX_CONFIDENCE})`,
    ignore: skip,
    async fn() {
      const eml = await Deno.readTextFile(`${NOT_PO_DIR}${file}`);
      const r = await postEmail(eml);
      const cls = r.prior_classification ?? r.classification;
      const conf = r.confidence ?? -1;
      if (cls !== "NOT_PO" || conf > NOT_PO_MAX_CONFIDENCE) {
        throw new Error(`Expected NOT_PO with conf <= ${NOT_PO_MAX_CONFIDENCE}; got ${cls} @ ${conf}. Body: ${JSON.stringify(r).slice(0, 400)}`);
      }
    },
  });
}

if (skip) {
  Deno.test({ name: "[skipped] SUPABASE_ANON_KEY not set", fn() {/**/} });
}
