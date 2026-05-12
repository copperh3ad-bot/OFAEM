/**
 * Revision diff helper.
 *
 * As of phase 3a the insert + supersede flow runs atomically in the
 * upsert_extraction_versioned() Postgres function under an advisory xact lock.
 * The TS layer is left with just one job: compute a human-readable diff
 * between the prior payload (returned by the RPC) and the new payload, for
 * storage in ai_extractions.revision_diff.
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

export interface RevisionDiff {
  previous_version: number;
  previous_extraction_id: string;
  added: LineItemForDiff[];
  removed: LineItemForDiff[];
  modified: Array<{ sku: string; changes: Record<string, { old: unknown; new: unknown }> }>;
  metadata_changes: Record<string, { old: unknown; new: unknown }>;
}

const TRACKED_LINE_FIELDS: Array<keyof LineItemForDiff> = ["quantity", "unit", "unit_price", "description"];
const TRACKED_METADATA_FIELDS = ["po_date", "currency", "payment_method", "delivery_destination", "consignee"];

function indexBySku(items: LineItemForDiff[]): Map<string, LineItemForDiff> {
  const m = new Map<string, LineItemForDiff>();
  for (const it of items) m.set(it.sku, it);
  return m;
}

export function computePayloadDiff(
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
    if (Object.keys(changes).length > 0) modified.push({ sku, changes });
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
