import { useEffect, useState, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import type { AIExtraction, LineItem, CrisisAlert, ProformaInvoice } from "../lib/types";

const PROFORMA_BUCKET = "proforma-invoices";
const SIGNED_URL_EXPIRY_SECONDS = 3600;

function fmtCurrency(value: number, currency: string): string {
  return `${currency} ${value.toFixed(2)}`;
}

export default function PODetail() {
  const { id } = useParams<{ id: string }>();
  const { user, role } = useAuth();
  const [extraction, setExtraction] = useState<AIExtraction | null>(null);
  const [crises, setCrises] = useState<CrisisAlert[]>([]);
  const [proformas, setProformas] = useState<ProformaInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [savingLine, setSavingLine] = useState<number | null>(null);
  const [signingOff, setSigningOff] = useState(false);
  const [generatingProforma, setGeneratingProforma] = useState(false);
  const [editBuffer, setEditBuffer] = useState<Record<number, Partial<LineItem>>>({});

  const load = useCallback(async () => {
    if (!id) return;
    setError(null);
    try {
      const [extResp, crResp, pfResp] = await Promise.all([
        supabase.from("ai_extractions").select("*").eq("id", id).maybeSingle(),
        supabase.from("crisis_alerts").select("*").eq("extraction_id", id).order("raised_at", { ascending: false }),
        supabase.from("proforma_invoices").select("*").eq("extraction_id", id).order("generated_at", { ascending: false }),
      ]);
      if (extResp.error) setError(extResp.error.message);
      setExtraction(extResp.data as AIExtraction | null);
      if (!crResp.error) setCrises((crResp.data as CrisisAlert[]) ?? []);
      if (!pfResp.error) setProformas((pfResp.data as ProformaInvoice[]) ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  // Initial fetch
  useEffect(() => { load(); }, [load]);

  // Realtime subscription: any change to this PO's extraction, crises, or proformas → refetch
  useEffect(() => {
    if (!id) return;
    const channel = supabase
      .channel(`po-detail-${id}`)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "ai_extractions", filter: `id=eq.${id}` },
        () => load())
      .on("postgres_changes",
        { event: "*", schema: "public", table: "crisis_alerts", filter: `extraction_id=eq.${id}` },
        () => load())
      .on("postgres_changes",
        { event: "*", schema: "public", table: "proforma_invoices", filter: `extraction_id=eq.${id}` },
        () => load())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [id, load]);

  function startEdit(lineNo: number, field: keyof LineItem, value: unknown) {
    setEditBuffer((b) => ({ ...b, [lineNo]: { ...b[lineNo], [field]: value } }));
  }

  async function saveLine(lineNo: number) {
    if (!extraction) return;
    setSavingLine(lineNo);
    setError(null); setInfo(null);
    try {
      const items = [...extraction.payload.line_items];
      const idx = items.findIndex((i) => i.line_no === lineNo);
      if (idx === -1) return;
      const original = items[idx];
      const patch = editBuffer[lineNo] ?? {};
      const updated = { ...original, ...patch, requires_review: false, review_reason: null };

      items[idx] = updated;
      const newPayload = { ...extraction.payload, line_items: items };

      const totalValue = items.reduce((s, i) => s + (i.quantity * i.unit_price), 0);
      const totalCbm = items.reduce((s, i) => s + (i.cbm ?? 0), 0);
      const stillNeedsReview = items.some((i) => i.requires_review);
      newPayload.totals = {
        total_items: items.length,
        total_value: Math.round(totalValue * 100) / 100,
        total_cbm: Math.round(totalCbm * 10000) / 10000,
      };
      newPayload.flags = {
        ...newPayload.flags,
        requires_review: stillNeedsReview,
        is_ready_for_invoicing: !stillNeedsReview && newPayload.validation_summary.total_errors === 0,
      };
      newPayload.validation_summary = {
        ...newPayload.validation_summary,
        items_requiring_review: items.filter((i) => i.requires_review).length,
        total_warnings: items.filter((i) => i.requires_review).length,
        passed: !stillNeedsReview,
      };

      const { error: updErr } = await supabase
        .from("ai_extractions")
        .update({ payload: newPayload, reviewed_by: user?.id, reviewed_at: new Date().toISOString() })
        .eq("id", extraction.id);
      if (updErr) throw new Error(updErr.message);

      const feedbackRows = Object.entries(patch).map(([field, newVal]) => ({
        feedback_type: "cell_edit",
        source_module: "po_extraction",
        field_name: `line_items[${idx}].${field}`,
        original_value: String((original as unknown as Record<string, unknown>)[field] ?? ""),
        corrected_value: String(newVal ?? ""),
        context: { line_no: lineNo, sku: original.sku, customer_id: extraction.customer_id },
        extraction_id: extraction.id,
        entity_type: "purchase_order",
        user_email: user?.email,
        user_role: role,
      }));
      if (feedbackRows.length > 0) await supabase.from("ml_feedback").insert(feedbackRows);

      setEditBuffer((b) => { const c = { ...b }; delete c[lineNo]; return c; });
      setInfo(`Line ${lineNo} saved`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSavingLine(null);
    }
  }

  async function generateProforma() {
    if (!extraction) return;
    setGeneratingProforma(true); setError(null); setInfo(null);
    try {
      const { data, error: invErr } = await supabase.functions.invoke("render-proforma", {
        body: { extraction_id: extraction.id },
      });
      if (invErr) throw new Error(invErr.message);
      if (!data?.success) throw new Error(data?.error ?? "proforma generation failed");
      setInfo(`Proforma generated — checksum ${(data.checksum as string).slice(0, 12)}…`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGeneratingProforma(false);
    }
  }

  async function downloadProforma(invoice: ProformaInvoice) {
    setError(null);
    const { data, error: dlErr } = await supabase.storage
      .from(PROFORMA_BUCKET)
      .createSignedUrl(invoice.file_path, SIGNED_URL_EXPIRY_SECONDS);
    if (dlErr) { setError(dlErr.message); return; }
    if (data?.signedUrl) window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  }

  async function signOff() {
    if (!extraction) return;
    if (!(role === "Owner" || role === "Manager")) {
      setError("Only Owner or Manager can sign off");
      return;
    }
    setSigningOff(true); setError(null); setInfo(null);
    try {
      const items = extraction.payload.line_items;
      if (items.some((i) => i.requires_review)) {
        throw new Error("Some line items still require review — cannot sign off.");
      }

      // 1) Ensure a proforma_invoices row exists for this PO. If not, render one first.
      let invoiceId: string | null = proformas[0]?.id ?? null;
      if (!invoiceId) {
        const { data, error: invErr } = await supabase.functions.invoke("render-proforma", {
          body: { extraction_id: extraction.id },
        });
        if (invErr) throw new Error(invErr.message);
        if (!data?.success) throw new Error(data?.error ?? "proforma generation failed");
        invoiceId = data.invoice_id as string;
      }

      // 2) Flip ai_extractions.is_ready_for_invoicing
      const newPayload = {
        ...extraction.payload,
        flags: { ...extraction.payload.flags, is_ready_for_invoicing: true, requires_review: false },
      };
      const { error: extErr } = await supabase
        .from("ai_extractions")
        .update({
          payload: newPayload,
          is_ready_for_invoicing: true,
          reviewed_by: user?.id,
          reviewed_at: new Date().toISOString(),
        })
        .eq("id", extraction.id);
      if (extErr) throw new Error(extErr.message);

      // 3) Flip proforma_invoices.is_ready_for_invoicing → Postgres trigger sets
      //    signed_off_by + signed_off_at via auth.uid() (current_user_role check inside trigger)
      const { error: pfErr } = await supabase
        .from("proforma_invoices")
        .update({ is_ready_for_invoicing: true })
        .eq("id", invoiceId);
      if (pfErr) throw new Error(`signoff trigger rejected: ${pfErr.message}`);

      setInfo("Signed off. Proforma invoice marked ready.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSigningOff(false);
    }
  }

  if (loading) return <div className="p-8 text-slate-500">Loading PO…</div>;
  if (!extraction) return <div className="p-8 text-slate-500">Not found.</div>;

  const md = extraction.payload.metadata;
  const items = extraction.payload.line_items;
  const flags = extraction.payload.flags;
  const totals = extraction.payload.totals;
  const canSignOff = role === "Owner" || role === "Manager";
  const hasUnsavedEdits = Object.keys(editBuffer).length > 0;
  const stillNeedsReview = items.some((i) => i.requires_review);

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <header className="mb-6 flex justify-between items-start">
        <div>
          <Link to="/review" className="text-sm text-indigo-600 hover:underline">← Review Queue</Link>
          <h1 className="text-2xl font-semibold text-slate-900 mt-1">{md.po_id}</h1>
          <div className="text-sm text-slate-500">
            {md.customer_id} · v{extraction.version_number} · {md.source_document_type}
            {!extraction.is_current_version && (
              <span className="ml-2 px-2 py-0.5 bg-slate-200 text-slate-700 text-xs rounded">SUPERSEDED</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {flags.is_ready_for_invoicing && (
            <span className="px-3 py-1 bg-green-100 text-green-800 text-sm rounded">Ready for invoicing</span>
          )}
          {flags.requires_review && (
            <span className="px-3 py-1 bg-amber-100 text-amber-800 text-sm rounded">Requires review</span>
          )}
        </div>
      </header>

      {error && <div className="mb-4 bg-red-50 border border-red-200 text-red-800 text-sm rounded p-3">{error}</div>}
      {info  && <div className="mb-4 bg-green-50 border border-green-200 text-green-800 text-sm rounded p-3">{info}</div>}

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <Stat label="Total value" value={fmtCurrency(totals.total_value, md.currency)} />
        <Stat label="Line items" value={String(totals.total_items)} />
        <Stat label="Total CBM" value={`${totals.total_cbm} m³`} />
        <Stat label="Payment" value={md.payment_method ?? "—"} />
      </section>

      {crises.filter((c) => c.status !== "resolved").length > 0 && (
        <section className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4">
          <h2 className="font-semibold text-red-900 mb-2">Active crises</h2>
          <ul className="space-y-2">
            {crises.filter((c) => c.status !== "resolved").map((c) => (
              <li key={c.id} className="text-sm">
                <span className={`inline-block px-2 py-0.5 rounded text-xs mr-2 font-medium uppercase ${
                  c.severity === "critical" ? "bg-red-200 text-red-900" :
                  c.severity === "high"     ? "bg-orange-200 text-orange-900" :
                  c.severity === "medium"   ? "bg-yellow-200 text-yellow-900" :
                                              "bg-slate-200 text-slate-700"}`}>
                  {c.severity}
                </span>
                <span className="text-slate-900 font-medium">{c.crisis_type}</span>
                <span className="text-slate-700"> — {c.details}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="bg-white rounded-lg shadow-sm border border-slate-200 overflow-hidden mb-6">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 text-left">
            <tr>
              <th className="px-3 py-3 font-medium">#</th>
              <th className="px-3 py-3 font-medium">SKU</th>
              <th className="px-3 py-3 font-medium">Description</th>
              <th className="px-3 py-3 font-medium text-right">Qty</th>
              <th className="px-3 py-3 font-medium">Unit</th>
              <th className="px-3 py-3 font-medium text-right">Unit price</th>
              <th className="px-3 py-3 font-medium text-right">CBM</th>
              <th className="px-3 py-3 font-medium">Status</th>
              <th className="px-3 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((item, idx) => {
              const editing = editBuffer[item.line_no] ?? {};
              const isEdited = Object.keys(editing).length > 0;
              const rowClass = item.requires_review ? "bg-amber-50" : isEdited ? "bg-indigo-50" : "";
              return (
                <tr key={`${item.line_no}-${idx}`} className={rowClass}>
                  <td className="px-3 py-2 text-slate-500">{item.line_no}</td>
                  <td className="px-3 py-2">
                    <input defaultValue={item.sku} onChange={(e) => startEdit(item.line_no, "sku", e.target.value)} className="w-32 rounded border-slate-300 text-xs" />
                  </td>
                  <td className="px-3 py-2">
                    <input defaultValue={item.description} onChange={(e) => startEdit(item.line_no, "description", e.target.value)} className="w-full rounded border-slate-300 text-xs" />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input type="number" defaultValue={item.quantity} onChange={(e) => startEdit(item.line_no, "quantity", Number(e.target.value))} className="w-20 rounded border-slate-300 text-xs text-right" />
                  </td>
                  <td className="px-3 py-2">
                    <input defaultValue={item.unit} onChange={(e) => startEdit(item.line_no, "unit", e.target.value.toUpperCase())} className="w-20 rounded border-slate-300 text-xs uppercase" />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input type="number" step="0.01" defaultValue={item.unit_price} onChange={(e) => startEdit(item.line_no, "unit_price", Number(e.target.value))} className="w-24 rounded border-slate-300 text-xs text-right" />
                  </td>
                  <td className="px-3 py-2 text-right text-slate-600">{item.cbm?.toFixed(4) ?? "—"}</td>
                  <td className="px-3 py-2 text-xs">
                    {item.requires_review ? (
                      <div>
                        <span className="text-amber-700 font-medium">REVIEW</span>
                        {item.review_reason && <div className="text-slate-500 mt-0.5">{item.review_reason}</div>}
                      </div>
                    ) : <span className="text-green-700">OK</span>}
                  </td>
                  <td className="px-3 py-2">
                    {isEdited && (
                      <button onClick={() => saveLine(item.line_no)} disabled={savingLine === item.line_no}
                        className="text-indigo-600 hover:underline text-xs disabled:opacity-50">
                        {savingLine === item.line_no ? "Saving…" : "Save"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {/* Proforma invoices */}
      <section className="bg-white rounded-lg shadow-sm border border-slate-200 p-5 mb-6">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="font-semibold text-slate-900">Proforma Invoices</h2>
            <p className="text-sm text-slate-500 mt-0.5">
              Generate the invoice document. Sign-off below marks it ready for issuance.
            </p>
          </div>
          <button
            onClick={generateProforma}
            disabled={generatingProforma || hasUnsavedEdits || stillNeedsReview}
            title={stillNeedsReview ? "Resolve review items first" : hasUnsavedEdits ? "Save your edits first" : ""}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-md"
          >
            {generatingProforma ? "Generating…" : "Generate Proforma"}
          </button>
        </div>
        {proformas.length === 0 ? (
          <div className="text-sm text-slate-500 py-3 px-1">No proforma invoices generated yet.</div>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {proformas.map((pf) => (
              <li key={pf.id} className="py-3 flex items-center justify-between gap-4">
                <div className="flex-1">
                  <div className="font-mono text-xs text-slate-500">
                    {pf.checksum.slice(0, 16)}… ·{" "}
                    {new Date(pf.generated_at).toLocaleString()}
                  </div>
                  <div className="text-slate-700 mt-0.5">
                    {pf.total_value ? fmtCurrency(pf.total_value, md.currency) : "—"}
                    {pf.total_cbm != null && ` · ${pf.total_cbm} m³`}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {pf.is_ready_for_invoicing ? (
                    <span className="px-2 py-0.5 bg-green-100 text-green-800 text-xs rounded">SIGNED OFF</span>
                  ) : (
                    <span className="px-2 py-0.5 bg-slate-100 text-slate-700 text-xs rounded">DRAFT</span>
                  )}
                  <button onClick={() => downloadProforma(pf)} className="text-indigo-600 hover:underline text-sm">
                    Download HTML
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="bg-white rounded-lg shadow-sm border border-slate-200 p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-slate-900">Sign-off</h2>
            <p className="text-sm text-slate-500 mt-1">
              Owner or Manager confirms this PO is ready for invoicing. Sets the
              proforma_invoices flag; Postgres trigger captures signed_off_by /
              signed_off_at.
            </p>
          </div>
          {(() => {
            const proformaSignedOff = proformas.some((p) => p.is_ready_for_invoicing);
            const fullyDone = flags.is_ready_for_invoicing && proformaSignedOff;
            const label = fullyDone
              ? "Already signed off"
              : signingOff
                ? "Signing…"
                : "Sign off as ready for invoicing";
            const disabled = signingOff || fullyDone || stillNeedsReview || !canSignOff;
            const title = !canSignOff
              ? "Only Owner or Manager can sign off"
              : stillNeedsReview
                ? "Resolve review items first"
                : fullyDone
                  ? "Already signed off"
                  : "";
            return (
              <button
                onClick={signOff}
                disabled={disabled}
                title={title}
                className="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-md"
              >
                {label}
              </button>
            );
          })()}
        </div>
      </section>

      {extraction.revision_diff && (
        <section className="mt-6 bg-white rounded-lg shadow-sm border border-slate-200 p-5">
          <h2 className="font-semibold text-slate-900 mb-2">Revision diff</h2>
          <pre className="text-xs bg-slate-50 rounded p-3 overflow-auto">
            {JSON.stringify(extraction.revision_diff, null, 2)}
          </pre>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-4">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-lg font-semibold text-slate-900 mt-1">{value}</div>
    </div>
  );
}
