import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import type { CrisisAlert } from "../lib/types";

const SEV_COLOR: Record<string, string> = {
  critical: "bg-red-200 text-red-900",
  high:     "bg-orange-200 text-orange-900",
  medium:   "bg-yellow-200 text-yellow-900",
  low:      "bg-slate-200 text-slate-700",
};

interface AlertWithPo extends CrisisAlert {
  customer_id?: string;
  po_id?: string;
}

export default function Crises() {
  const { role } = useAuth();
  const [alerts, setAlerts] = useState<AlertWithPo[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    const { data: crises } = await supabase
      .from("crisis_alerts")
      .select("*")
      .neq("status", "resolved")
      .order("raised_at", { ascending: false });
    const rows = (crises as CrisisAlert[]) ?? [];
    // Enrich with PO id + customer_id
    const ids = [...new Set(rows.map((r) => r.extraction_id))];
    const { data: exts } = await supabase
      .from("ai_extractions")
      .select("id, customer_id, payload")
      .in("id", ids);
    const idx = new Map<string, { customer_id: string; po_id: string }>();
    for (const e of (exts as { id: string; customer_id: string; payload: { metadata: { po_id: string } } }[] | null) ?? []) {
      idx.set(e.id, { customer_id: e.customer_id, po_id: e.payload?.metadata?.po_id ?? "?" });
    }
    setAlerts(rows.map((r) => ({ ...r, ...(idx.get(r.extraction_id) ?? {}) })));
    setLoading(false);
  }

  async function resolve(id: string) {
    if (!(role === "Owner" || role === "Manager")) return;
    const notes = prompt("Resolution notes:");
    if (notes === null) return;
    setResolving(id);
    await supabase
      .from("crisis_alerts")
      .update({ status: "resolved", resolved_at: new Date().toISOString(), resolution_notes: notes })
      .eq("id", id);
    setResolving(null);
    await load();
  }

  if (loading) return <div className="p-8 text-slate-500">Loading…</div>;

  return (
    <div className="p-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">Active Crises</h1>
        <p className="text-sm text-slate-500 mt-1">
          {alerts.length} unresolved alert{alerts.length === 1 ? "" : "s"} across {new Set(alerts.map((a) => a.extraction_id)).size} PO{new Set(alerts.map((a) => a.extraction_id)).size === 1 ? "" : "s"}
        </p>
      </header>

      <div className="space-y-3">
        {alerts.length === 0 && (
          <div className="bg-white rounded-lg border border-slate-200 p-8 text-center text-slate-500">
            No active crises. Smooth sailing.
          </div>
        )}
        {alerts.map((a) => (
          <div key={a.id} className="bg-white rounded-lg shadow-sm border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 flex items-start justify-between gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`px-2 py-0.5 rounded text-xs font-medium uppercase ${SEV_COLOR[a.severity]}`}>{a.severity}</span>
                  <span className="text-slate-900 font-medium">{a.crisis_type.replace(/_/g, " ")}</span>
                  <span className="text-xs text-slate-500">·</span>
                  <Link to={`/orders/${a.extraction_id}`} className="text-xs text-indigo-600 hover:underline">
                    {a.po_id} ({a.customer_id})
                  </Link>
                  <span className="text-xs text-slate-400 ml-auto">{new Date(a.raised_at).toLocaleString()}</span>
                </div>
                <p className="text-sm text-slate-700">{a.details}</p>
                {a.mitigation_plan && (
                  <button
                    onClick={() => setExpanded(expanded === a.id ? null : a.id)}
                    className="text-xs text-indigo-600 hover:underline mt-2"
                  >
                    {expanded === a.id ? "Hide" : "Show"} mitigation plan
                  </button>
                )}
              </div>
              <div className="flex-shrink-0">
                {(role === "Owner" || role === "Manager") && (
                  <button
                    onClick={() => resolve(a.id)}
                    disabled={resolving === a.id}
                    className="px-3 py-1 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-xs rounded"
                  >
                    {resolving === a.id ? "Resolving…" : "Mark resolved"}
                  </button>
                )}
              </div>
            </div>
            {expanded === a.id && a.mitigation_plan && (
              <div className="px-5 pb-4 bg-slate-50 border-t border-slate-200">
                <pre className="text-xs mt-3 whitespace-pre-wrap text-slate-700">
                  {JSON.stringify(a.mitigation_plan, null, 2)}
                </pre>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
