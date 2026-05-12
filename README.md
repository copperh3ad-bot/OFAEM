# OFAEM — Order Fulfillment Automation Engine (Microservice)

Standalone microservice for parsing buyer purchase orders (PDF / image / Excel / email)
into a validated, structured contract suitable for downstream ERP consumption.

**Stack:** Deno + Supabase (Postgres, Edge Functions, Storage). No Python service.

## Pipeline

```
Inbound email (webhook from Gmail / SES / Mailgun / IMAP poller)
  → ingest-email edge function
      → MIME parse → classifier (is this a PO? confidence ≥ 0.65)
      → if PO: idempotency check on Message-ID, then call extractor
  → parse-po edge function (or runExtraction in-process)
      → Anthropic Claude, Haiku → Sonnet confidence fallback
      → AI-driven SKU matching (pg_trgm pre-filter → Claude disambiguation)
      → CBM enrichment (three-tier resolution)
      → revision detection (supersede prior version of same po_id; store diff)
  → ai_extractions table (versioned, only current version flagged)
  → human review (cell edits → ml_feedback for ML loop)
  → render-proforma edge function (CBM totals + invoice HTML)
  → proforma_invoices table (checksum, sign-off gated by role)
```

## Auto-import from email

`POST /functions/v1/ingest-email` — accepts a raw MIME email and:

1. Parses MIME (text body + attachments), classifies it via Claude Haiku
2. If classifier says it's NOT a PO (e.g. status inquiry, RFQ, complaint): logs to `email_ingest_log` with classification=NOT_PO and exits
3. If it IS a PO: runs extraction in-process, returns the normalized PO
4. Deduplicates on RFC822 Message-ID (same email retried → no duplicate extraction)
5. If a prior extraction exists for the same `(customer_id, po_id)`:
   - new row gets `version_number = prior + 1`
   - prior row is marked `is_current_version=false`, `superseded_by_id=<new>`
   - structured diff of changes is stored on the new row in `revision_diff` JSONB

Default `customer_id` is derived from the sender email domain — caller can override.

Wire it to your mail provider:

| Provider | How |
|---|---|
| Gmail | Watch + Pub/Sub → Cloud Function → POST raw_email |
| AWS SES | SES rule → Lambda → POST raw_email |
| Mailgun | Mailgun Routes → forward to your function URL |
| SendGrid | Inbound Parse → POST to your function URL |
| Plain IMAP | Cron job polling IMAP → POST each new message |

Request shape:
```json
{
  "raw_email": "<full RFC822 message>",
  "customer_id": "BUYER_X",      // optional; defaults to sender domain
  "source_label": "gmail-inbox"  // optional, for logging
}
```

## Request formats

`POST /functions/v1/parse-po`

```jsonc
// EMAIL / MANUAL
{
  "source_type": "EMAIL",
  "customer_id": "BUYER_X",
  "document_content": "PO #123 ..."
}

// PDF
{
  "source_type": "PDF",
  "customer_id": "BUYER_X",
  "file_base64": "<base64 of PDF bytes, no data: prefix>",
  "file_mime": "application/pdf"
}

// IMAGE
{
  "source_type": "IMAGE",
  "customer_id": "BUYER_X",
  "file_base64": "<base64>",
  "file_mime": "image/jpeg" | "image/png" | "image/webp"
}

// EXCEL — parsed to CSV text via SheetJS; embedded images extracted automatically
{
  "source_type": "EXCEL",
  "customer_id": "BUYER_X",
  "file_base64": "<base64>",
  "file_mime": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
}

// EMAIL with raw MIME (inline images extracted automatically)
{
  "source_type": "EMAIL",
  "customer_id": "BUYER_X",
  "raw_email": "<full RFC822 / MIME multipart>"
}

// Any source_type — explicit additional images passed by the caller
{
  "source_type": "PDF",
  "customer_id": "BUYER_X",
  "file_base64": "<pdf base64>",
  "file_mime": "application/pdf",
  "attachments": [
    { "file_base64": "<image base64>", "file_mime": "image/png", "filename": "annotation.png" }
  ]
}
```

Embedded images:
- **Excel:** anything in `xl/media/` inside the .xlsx zip is pulled out and sent as image content blocks (covers "Insert Picture", "Insert Picture in Cell", pasted screenshots).
- **Email:** when `raw_email` is provided, the MIME multipart is parsed; `image/*` inline parts and CID-referenced images are passed to the LLM as image content blocks.
- **Cap:** maximum 6 image blocks per request (cost control). Caller-supplied attachments are appended after auto-extracted ones, then truncated.

Response includes `inline_images_processed: N` so callers can verify pickup.

Max file size: 8 MB raw (Supabase request body limit is ~6 MB after base64 inflation).

## Layout

| Path | Purpose |
|---|---|
| `schemas/po_normalized_schema.json` | Immutable JSON Schema (draft-07) for the PO contract |
| `supabase/functions/parse-po/` | LLM extraction edge function |
| `supabase/functions/render-proforma/` | CBM + invoice render edge function |
| `supabase/functions/_shared/` | CBM engine, confidence rollup, prompts |
| `supabase/migrations/` | Postgres schema, RLS, triggers |
| `templates/proforma_invoice.html` | Eta template (HTML autoescape ON) |
| `tests/unit/` | Pure unit tests (CBM, confidence) |
| `tests/integration/` | End-to-end pipeline tests |
| `scripts/seed_master_articles.ts` | Sample SKU data for fuzzy matching tests |

## Setup

```bash
supabase link --project-ref <YOUR_REF>
supabase db push                # applies migrations
supabase functions deploy parse-po
supabase functions deploy render-proforma
deno test --allow-env --allow-net tests/
```

Required env on the Supabase project:
- `ANTHROPIC_API_KEY`
- `SUPABASE_URL` (auto-injected)
- `SUPABASE_SERVICE_ROLE_KEY` (auto-injected from Vault)

## Confidence gates

| Field confidence | Behavior |
|---|---|
| ≥ 0.80 sku, ≥ 0.75 qty/unit/price | Auto-pass |
| Any below threshold OR dimensions=HEURISTIC | `requires_review = true` |
| LLM overall < 0.70 | Auto-retry on Sonnet |

`is_ready_for_invoicing` is set to `true` only when:
- zero validation errors
- zero items require review
- ≥ 1 line item present

Sign-off (flipping the flag) is gated to Owner/Manager via Postgres trigger.

## Architecture decisions

- Single-tenant (one org). `customer_id` = buyer brand, not tenant.
- Role-based RLS using `user_profiles.role` (Owner, Manager, Merchandiser, Viewer, Supplier).
- Error learning uses `ml_feedback` table — every human correction is a labelled training example.
- CBM heuristics keyed on `(category, unit)` to avoid double-counting on linear-quantified fabric.
