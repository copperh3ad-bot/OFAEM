# OFAEM — Order Fulfillment Automation Engine (Microservice)

Standalone microservice for parsing buyer purchase orders (PDF / image / Excel / email)
into a validated, structured contract suitable for downstream ERP consumption.

**Stack:** Deno + Supabase (Postgres, Edge Functions, Storage). No Python service.

## Pipeline

```
Raw PO (PDF/IMG/XLSX/EMAIL)
  → parse-po edge function (Anthropic Claude, Haiku→Sonnet confidence fallback)
  → ai_extractions table (normalized JSON + per-field confidence)
  → human review (cell edits → ml_feedback for ML loop)
  → render-proforma edge function (CBM enrichment + invoice HTML)
  → proforma_invoices table (checksum, sign-off gated by role)
```

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
