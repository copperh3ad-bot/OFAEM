/**
 * Revision detection + supersede logic.
 *
 * After a new ai_extractions row is inserted, this module:
 *   1. Looks for prior rows with the same (customer_id, po_id) marked is_current_version=true
 *   2. Computes a structured diff between the prior and new payloads
 *   3. Marks the prior row(s) as superseded; assigns version_number = prior_max + 1 to new row
 *   4. Stores the diff on the new row as revision_diff JSON
 *
 * Diff shape:
 *   {
 *     "previous_version": <int>,
 *     "previous_extraction_id": <uuid>,
 *     "added":    [<line_item>],
 *     "removed":  [<line_item>],
 *     "modified": [{ "sku": "...", "changes": {"field": {"old":..,"new":..}} }],
 *     "metadata_changes": { "field": {"old":..,"new":..} }
 *   }
 */

interface LineItemForDiff {
  sku: string;
  quantity: number;
  unit: string;
  unit_price: number;
  description?: string;
}

interface Payload {
  metadata: Record<string, unknown> & { po_id?: string };
  line_items: LineItemForDiff[];
}

interface RevisionDiff {
  previous_version: number;
  previous_extraction_id: string;
  added: LineItemForDiff[];
  removed: LineItemForDiff[];
  modified: Array<{ sku: string; changes: Record<string, { old: unknown; new: unknown }> }>;
  metadata_changes: Record<string, { old: unknown; new: unknown }>;
}

const TRACKED_LINE_FIELDS: Array<keyof LineItemForDiff> = ["quantity", "unit", "unit_price", "description"];
const TRACKED_METADATA_FIELDS = [
  "po_date", "currency", "payment_method", "delivery_destination", "consignee",
];

function indexBySku(items: LineItemForDiff[]): Map<string, LineItemForDiff> {
  const m = new Map<string, LineItemForDiff>();
  for (const it of items) m.set(it.sku, it);
  return m;
}

function computeDiff(
  previous: { id: string; version_number: number; payload: Payload },
  next: Payload,
): RevisionDiff {
  const oldItems = indexBySku(previous.payload.line_items ?? []);
  const newItems = indexBySku(next.line_items ?? []);

  const added: LineItemForDiff[] = [];
  const removed: LineItemForDiff[] = [];
  const modified: RevisionDiff["modified"] = [];

  for (const [sku, item] of newItems) {
    if (!oldItems.has(sku)) {
      added.push(item);
      continue;
    }
    const prev = oldItems.get(sku)!;
    const changes: Record<string, { old: unknown; new: unknown }> = {};
    for (const f of TRACKED_LINE_FIELDS) {
      if (prev[f] !== item[f]) {
        changes[f] = { old: prev[f] ?? null, new: item[f] ?? null };
      }
    }
    if (Object.keys(changes).length > 0) {
      modified.push({ sku, changes });
    }
  }
  for (const [sku, item] of oldItems) {
    if (!newItems.has(sku)) removed.push(item);
  }

  const metadataChanges: Record<string, { old: unknown; new: unknown }> = {};
  for (const f of TRACKED_METADATA_FIELDS) {
    const oldV = (previous.payload.metadata as Record<string, unknown>)[f] ?? null;
    const newV = (next.metadata as Record<string, unknown>)[f] ?? null;
    if (oldV !== newV) metadataChanges[f] = { old: oldV, new: newV };
  }

  return {
    previous_version: previous.version_number,
    previous_extraction_id: previous.id,
    added,
    removed,
    modified,
    metadata_changes: metadataChanges,
  };
}

export interface RevisionResult {
  is_revision: boolean;
  version_number: number;
  superseded_ids: string[];
  diff: RevisionDiff | null;
}

/**
 * Look up prior versions of this PO, mark them superseded, and update the
 * new extraction row with version_number and revision_diff.
 *
 * Uses the supabase service_role client (passed in) so it bypasses RLS.
 */
export async function detectAndApplyRevision(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  newExtractionId: string,
  customerId: string,
  poId: string,
  newPayload: Payload,
): Promise<RevisionResult> {
  // Find prior current-version rows for the same (customer, po_id)
  const { data: priors, error } = await supabase
    .from("ai_extractions")
    .select("id, version_number, payload")
    .eq("kind", "purchase_order")
    .eq("customer_id", customerId)
    .eq("is_current_version", true)
    .neq("id", newExtractionId)
    .filter("payload->metadata->>po_id", "eq", poId);

  if (error || !Array.isArray(priors) || priors.length === 0) {
    // First version
    return { is_revision: false, version_number: 1, superseded_ids: [], diff: null };
  }

  // Compute diff against the highest-version prior (there should be only one
  // is_current_version=true row per po_id, but be defensive)
  const sorted = [...priors].sort((a, b) => (b.version_number ?? 1) - (a.version_number ?? 1));
  const baseline = sorted[0];
  const diff = computeDiff(
    { id: baseline.id, version_number: baseline.version_number ?? 1, payload: baseline.payload as Payload },
    newPayload,
  );

  const nextVersion = (baseline.version_number ?? 1) + 1;

  // Mark all prior current rows as superseded
  const supersededIds: string[] = [];
  for (const prior of priors) {
    const { error: updErr } = await supabase
      .from("ai_extractions")
      .update({ is_current_version: false, superseded_by_id: newExtractionId })
      .eq("id", prior.id);
    if (!updErr) supersededIds.push(prior.id);
  }

  // Update the new row with version_number + diff
  await supabase
    .from("ai_extractions")
    .update({
      version_number: nextVersion,
      is_current_version: true,
      revision_diff: diff,
    })
    .eq("id", newExtractionId);

  return { is_revision: true, version_number: nextVersion, superseded_ids: supersededIds, diff };
}
