import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import type { WorkflowStateRow } from "../lib/types";

const STAGE_COLORS: Record<string, string> = {
  PO_INTAKE_VALIDATION: "bg-slate-100 text-slate-700",
  LOGISTICAL_PLANNING: "bg-blue-100 text-blue-800",
  SCHEDULING_DOCUMENTATION: "bg-indigo-100 text-indigo-800",
  QUALITY_COMPLIANCE: "bg-amber-100 text-amber-800",
  CRISIS_MANAGEMENT: "bg-red-100 text-red-800",
  READY_SHIPMENT: "bg-green-100 text-green-800",
};

export default function AllOrders() {
  const [rows, setRows] = useState<WorkflowStateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    supabase
      .from("workflow_state")
      .select("*")
      .order("po_id")
      .then(({ data }) => {
        setRows((data as WorkflowStateRow[]) ?? []);
        setLoading(false);
      });
  }, []);

  const filtered = rows.filter((r) =>
    !search
      ? true
      : r.po_id.toLowerCase().includes(search.toLowerCase())
        || r.customer_id.toLowerCase().includes(search.toLowerCase())
  );

  if (loading) return <div className="p-8 text-slate-500">Loading…</div>;

  return (
    <div className="p-8">
      <header className="mb-6 flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">All Purchase Orders</h1>
          <p className="text-sm text-slate-500 mt-1">{filtered.length} current PO{filtered.length === 1 ? "" : "s"}</p>
        </div>
        <input
          placeholder="Search PO or customer…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-64 rounded-md border-slate-300 text-sm"
        />
      </header>

      <div className="bg-white rounded-lg shadow-sm border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 text-left">
            <tr>
              <th className="px-4 py-3 font-medium">PO #</th>
              <th className="px-4 py-3 font-medium">Customer</th>
              <th className="px-4 py-3 font-medium">Version</th>
              <th className="px-4 py-3 font-medium">Stage</th>
              <th className="px-4 py-3 font-medium">Shipping</th>
              <th className="px-4 py-3 font-medium">Delivery</th>
              <th className="px-4 py-3 font-medium">Crises</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.map((r) => (
              <tr key={r.extraction_id} className="hover:bg-slate-50">
                <td className="px-4 py-3 font-medium text-slate-900">{r.po_id}</td>
                <td className="px-4 py-3">{r.customer_id}</td>
                <td className="px-4 py-3 text-slate-600">v{r.version_number}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded text-xs ${STAGE_COLORS[r.current_stage] ?? "bg-slate-100"}`}>
                    {r.current_stage.replace(/_/g, " ")}
                  </span>
                </td>
                <td className="px-4 py-3 text-slate-700 text-xs">
                  {r.shipping_method ?? "—"}
                  {r.estimated_transit_days && ` · ${r.estimated_transit_days}d`}
                </td>
                <td className="px-4 py-3 text-slate-700 text-xs">{r.scheduled_delivery_date ?? "—"}</td>
                <td className="px-4 py-3">
                  {r.active_crisis_count > 0
                    ? <span className="text-red-700 text-xs font-medium">{r.active_crisis_count}</span>
                    : <span className="text-slate-400 text-xs">—</span>}
                </td>
                <td className="px-4 py-3 text-right">
                  <Link to={`/orders/${r.extraction_id}`} className="text-indigo-600 hover:underline text-sm">Open →</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
