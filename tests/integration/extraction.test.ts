// Extraction fixture test suite.
//
// For every <name>.expected.json under tests/fixtures/pos/expected/ this test
// loads the matching input under tests/fixtures/pos/inputs/, POSTs it to the
// live parse-po edge function, then asserts the response against the
// expected-spec invariants via tests/helpers/compare.ts.
//
// Env vars required (skipped if absent):
//   SUPABASE_URL          — defaults to https://ouxnplyjzlbhmvpcvjmx.supabase.co
//   SUPABASE_ANON_KEY     — anon JWT (auth header)
//
// Run:
//   SUPABASE_ANON_KEY=eyJ... deno test --allow-env --allow-net --allow-read tests/integration/extraction.test.ts

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { compare, formatViolations, type ExpectedSpec, type ExtractionResponseShape } from "../helpers/compare.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "https://ouxnplyjzlbhmvpcvjmx.supabase.co";
const ANON = Deno.env.get("SUPABASE_ANON_KEY");

const FIXTURES_DIR = new URL("../fixtures/pos/", import.meta.url).pathname;

interface RequestPayload {
  source_type: string;
  customer_id: string;
  document_content?: string;
  raw_email?: string;
  file_base64?: string;
  file_mime?: string;
}

async function buildPayload(spec: ExpectedSpec): Promise<RequestPayload> {
  const inputPath = `${FIXTURES_DIR}inputs/${spec.fixture}`;
  const customerId = `FIXTURE_${spec.fixture.replace(/\W+/g, "_").toUpperCase()}`;

  if (spec.source_type === "EMAIL") {
    const raw = await Deno.readTextFile(inputPath);
    if (spec.raw_email) return { source_type: "EMAIL", customer_id: customerId, raw_email: raw };
    return { source_type: "EMAIL", customer_id: customerId, document_content: raw };
  }

  const bytes = await Deno.readFile(inputPath);
  const b64 = encodeBase64(bytes);
  return {
    source_type: spec.source_type,
    customer_id: customerId,
    file_base64: b64,
    file_mime: spec.file_mime!,
  };
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return btoa(binary);
}

async function listSpecs(): Promise<ExpectedSpec[]> {
  const specs: ExpectedSpec[] = [];
  for await (const entry of Deno.readDir(`${FIXTURES_DIR}expected/`)) {
    if (!entry.isFile || !entry.name.endsWith(".expected.json")) continue;
    const text = await Deno.readTextFile(`${FIXTURES_DIR}expected/${entry.name}`);
    specs.push(JSON.parse(text) as ExpectedSpec);
  }
  return specs.sort((a, b) => a.fixture.localeCompare(b.fixture));
}

const skip = !ANON;
const specs = skip ? [] : await listSpecs();

for (const spec of specs) {
  Deno.test({
    name: `[fixture] ${spec.fixture}`,
    ignore: skip,
    // Each LLM-call test can take 30+ s on Sonnet fallback — Deno's default OK
    async fn() {
      const payload = await buildPayload(spec);
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/parse-po`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${ANON}`,
          "apikey": ANON!,
        },
        body: JSON.stringify(payload),
      });
      const body = (await resp.json()) as ExtractionResponseShape;

      // Quick sanity: HTTP and success flag
      assertEquals(resp.status, 200, `HTTP ${resp.status}: ${JSON.stringify(body).slice(0, 400)}`);
      assertEquals(body.success, true, `extraction failed: ${JSON.stringify(body).slice(0, 400)}`);

      // Invariants
      const violations = compare(spec, body);
      if (violations.length > 0) {
        throw new Error(
          `Fixture ${spec.fixture} violated ${violations.length} expectation(s):\n${formatViolations(violations)}\n` +
          `\nActual extraction:\n${JSON.stringify(body.normalized_po, null, 2).slice(0, 2000)}`,
        );
      }
    },
  });
}

if (skip) {
  Deno.test({
    name: "[skipped] SUPABASE_ANON_KEY not set",
    fn() { /* informational */ },
  });
}
