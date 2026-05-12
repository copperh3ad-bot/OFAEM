import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import type { WorkflowStateRow } from "../lib/types";

export default function ReviewQueue() {
  const [rows, setRows] = useState<WorkflowStateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from("workflow_state")
        .select("*")
        .eq("requires_review", true)
        .order("po_id");
      if (error) setError(error.message);
      else setRows((data as WorkflowStateRow[]) ?? []);
      setLoading(false);
    })();
  }, []);

  if (loading) return <div className="p-8 text-slate-500">Loading…</div>;
  if (error) return <div className="p-8 text-red-600">Error: {error}</div>;

  return (
    <div className="p-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">Review Queue</h1>
        <p className="text-sm text-slate-500 mt-1">
          {rows.length} PO{rows.length === 1 ? "" : "s"} need a human to confirm extracted data
        </p>
      </header>

      <div className="bg-white rounded-lg shadow-sm border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 text-left">
            <tr>
              <th className="px-4 py-3 font-medium">PO #</th>
              <th className="px-4 py-3 font-medium">Customer</th>
              <th className="px-4 py-3 font-medium">Version</th>
              <th className="px-4 py-3 font-medium">Stage</th>
              <th className="px-4 py-3 font-medium">Crises</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-slate-500">
                Nothing in the queue. Every current PO has cleared review.
              </td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.extraction_id} className="hover:bg-slate-50">
                <td className="px-4 py-3 font-medium text-slate-900">{r.po_id}</td>
                <td className="px-4 py-3 text-slate-700">{r.customer_id}</td>
                <td className="px-4 py-3 text-slate-700">v{r.version_number}</td>
                <td className="px-4 py-3 text-slate-700 text-xs">{r.current_stage.replace(/_/g, " ")}</td>
                <td className="px-4 py-3">
                  {r.active_crisis_count > 0 ? (
                    <span className="px-2 py-0.5 bg-red-100 text-red-800 text-xs rounded">
                      {r.active_crisis_count} active
                    </span>
                  ) : (
                    <span className="text-slate-400 text-xs">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <Link
                    to={`/orders/${r.extraction_id}`}
                    className="text-indigo-600 hover:underline text-sm"
                  >
                    Review →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
