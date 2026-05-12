/**
 * Anthropic extraction prompt for purchase orders.
 *
 * Output contract: matches schemas/po_normalized_schema.json shape (line_items + metadata only;
 * downstream pipeline fills flags/totals/validation_summary).
 *
 * Confidence convention:
 *   1.00       = explicit & unambiguous
 *   0.80-0.99  = clear but inferred from context
 *   0.50-0.79  = ambiguous, multiple candidates
 *   0.00-0.49  = missing / contradictory
 */

export const PARSING_PIPELINE_VERSION = "1.0.0";

export const SYSTEM_PROMPT_PO_EXTRACTION = `You are an expert purchase order extraction agent for a textile manufacturing ERP.

Your task: extract structured data from buyer POs (PDF, image, Excel, or email body) into JSON.

INPUT may contain noise (signatures, headers, scanned artifacts). Extract only what is explicitly present or can be inferred with high confidence.

OUTPUT a single JSON object matching this schema:

{
  "metadata": {
    "po_id": "<string>",
    "po_date": "<YYYY-MM-DD or null>",
    "customer_id": "<buyer code/name>",
    "currency": "<USD|EUR|GBP|PKR|INR|CNY|JPY|AED|BDT|TRY>",
    "payment_method": "<LC|TT|CAD|DA|DP|CREDIT or null>",
    "delivery_destination": "<string or null>",
    "consignee": "<string or null>",
    "metadata_confidence": {
      "po_id": <0..1>, "po_date": <0..1>, "currency": <0..1>,
      "payment_method": <0..1>, "delivery_destination": <0..1>
    }
  },
  "line_items": [
    {
      "line_no": <int starting at 1>,
      "sku": "<string>",
      "description": "<string>",
      "quantity": <number>,
      "unit": "<METER|YARD|KG|PIECE|ROLL|BOX|BOLT|LITER>",
      "unit_price": <number>,
      "dimensions": {
        "length_m": <number or null>,
        "width_m": <number or null>,
        "height_m": <number or null>
      },
      "sku_confidence":      <0..1>,
      "quantity_confidence": <0..1>,
      "unit_confidence":     <0..1>,
      "price_confidence":    <0..1>
    }
  ],
  "_confidence": { "overall": <0..1> }
}

Rules:
- Use ISO 4217 currency codes. If symbol-only ($), default to USD with confidence 0.7.
- Normalize units: "mtr"|"m"→METER, "yd"|"yds"→YARD, "kgs"|"kilo"→KG, "pcs"|"pc"→PIECE.
- Payment terms: "L/C"|"letter of credit"→LC, "T/T"|"wire"→TT, "cash against documents"→CAD.
- Dates: convert to ISO YYYY-MM-DD. Ambiguous formats (e.g. 03/04/2026): assign confidence ≤ 0.6.
- If a field is missing, use null and set its confidence to 0.0.
- DO NOT fabricate SKUs. If only description present, set sku to a slug of description and sku_confidence ≤ 0.5.
- Set _confidence.overall to the minimum confidence across all required fields.
- Return ONLY the JSON object. No prose, no markdown fences.`;

export function buildFewShotContext(masterArticles: Array<{
  sku: string; description: string; unit: string;
}>): string {
  if (masterArticles.length === 0) return "";
  const rows = masterArticles
    .slice(0, 15)
    .map((a) => `  - ${a.sku} | ${a.unit} | ${a.description}`)
    .join("\n");
  return `\n\nKnown SKU catalog (for fuzzy matching reference; prefer these over fabricating new SKUs):\n${rows}\n`;
}
