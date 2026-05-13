import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import type { WorkflowStage, WorkflowStateRow } from "../lib/types";

interface StageCounts { stage: WorkflowStage | string; count: number }

const STAGE_ORDER: WorkflowStage[] = [
  "PO_INTAKE_VALIDATION",
  "LOGISTICAL_PLANNING",
  "SCHEDULING_DOCUMENTATION",
  "QUALITY_COMPLIANCE",
  "CRISIS_MANAGEMENT",
  "READY_SHIPMENT",
];

const STAGE_COLORS: Record<string, string> = {
  PO_INTAKE_VALIDATION: "bg-slate-200 text-slate-800",
  LOGISTICAL_PLANNING: "bg-blue-100 text-blue-900",
  SCHEDULING_DOCUMENTATION: "bg-indigo-100 text-indigo-900",
  QUALITY_COMPLIANCE: "bg-amber-100 text-amber-900",
  CRISIS_MANAGEMENT: "bg-red-100 text-red-900",
  READY_SHIPMENT: "bg-green-100 text-green-900",
};

export default function Dashboard() {
  const [counts, setCounts] = useState<StageCounts[]>([]);
  const [reviewQueueSize, setReviewQueueSize] = useState<number>(0);
  const [recentPos, setRecentPos] = useState<WorkflowStateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data: rows, error } = await supabase
      .from("workflow_state")
      .select("*")
      .order("po_id");
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    const all = (rows as WorkflowStateRow[]) ?? [];
    const byStage = new Map<string, number>();
    for (const r of all) byStage.set(r.current_stage, (byStage.get(r.current_stage) ?? 0) + 1);
    setCounts(STAGE_ORDER.map((s) => ({ stage: s, count: byStage.get(s) ?? 0 })));
    setReviewQueueSize(all.filter((r) => r.requires_review).length);
    setRecentPos(all.slice(0, 10));
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Live refresh on any change to ai_extractions / crises / proformas
  useEffect(() => {
    const channel = supabase
      .channel("dashboard-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "ai_extractions" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "crisis_alerts" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "logistical_plans" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "compliance_records" }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load]);

  if (loading) return <div className="p-8 text-slate-500">Loading dashboard…</div>;
  if (error) return <div className="p-8 text-red-600">Error: {error}</div>;

  return (
    <div className="p-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">Dashboard</h1>
        <p className="text-sm text-slate-500 mt-1">
          {counts.reduce((s, c) => s + c.count, 0)} active POs across {STAGE_ORDER.length} workflow stages
        </p>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-8">
        {counts.map((c) => (
          <div
            key={c.stage}
            className={`rounded-lg p-4 ${STAGE_COLORS[c.stage] ?? "bg-slate-100"}`}
          >
            <div className="text-2xl font-bold">{c.count}</div>
            <div className="text-xs mt-1 leading-tight">{c.stage.replace(/_/g, " ")}</div>
          </div>
        ))}
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white rounded-lg shadow-sm border border-slate-200">
          <div className="px-5 py-4 border-b border-slate-200 flex justify-between items-center">
            <h2 className="font-semibold text-slate-900">Review Queue</h2>
            <Link to="/review" className="text-sm text-indigo-600 hover:underline">View all →</Link>
          </div>
          <div className="p-5">
            <div className="text-3xl font-bold text-amber-700">{reviewQueueSize}</div>
            <div className="text-sm text-slate-500 mt-1">items awaiting human review</div>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow-sm border border-slate-200">
          <div className="px-5 py-4 border-b border-slate-200">
            <h2 className="font-semibold text-slate-900">Recent POs</h2>
          </div>
          <ul className="divide-y divide-slate-100">
            {recentPos.length === 0 && (
              <li className="px-5 py-4 text-sm text-slate-500">No purchase orders yet.</li>
            )}
            {recentPos.map((r) => (
              <li key={r.extraction_id} className="px-5 py-3 flex items-center justify-between">
                <Link
                  to={`/orders/${r.extraction_id}`}
                  className="text-sm font-medium text-slate-900 hover:text-indigo-600"
                >
                  {r.po_id}
                </Link>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-slate-500">{r.customer_id}</span>
                  <span className={`px-2 py-0.5 rounded ${STAGE_COLORS[r.current_stage] ?? "bg-slate-100"}`}>
                    {r.current_stage.replace(/_/g, " ")}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
