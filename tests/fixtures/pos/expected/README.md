# Expected-output assertion specs

Each `<fixture>.expected.json` describes the **invariants** the extraction
pipeline must produce for the matching input fixture. We do NOT pin the
full JSON output because LLM responses are non-deterministic (different
phrasing of descriptions, slight quantity-precision drift, etc.) — instead
we assert what genuinely matters for downstream systems:

| Field | Assertion form |
|---|---|
| `metadata.po_id` | `po_id_contains` substring match |
| `metadata.currency` | exact enum value |
| `metadata.payment_method` | exact enum value |
| `line_items_count` | `min` and `max` bound the expected number of lines |
| `line_items.must_include_sku_substrings` | each listed substring must appear in some line's sku |
| `totals.total_value` | `within_pct` of an expected number (e.g. 5%) |
| `totals.total_cbm` | `min` lower bound |
| `flags.requires_review` | boolean expectation |
| `flags.is_ready_for_invoicing` | boolean expectation |

The `tests/helpers/compare.ts` module enforces these assertions. Failures
print the actual extraction next to the violated rule.
