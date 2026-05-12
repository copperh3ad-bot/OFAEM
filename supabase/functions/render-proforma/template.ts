// Inlined Eta template for proforma invoice.
// Kept as a TS export so `supabase functions deploy` picks it up as a static import.
// Edit the template HTML below and redeploy — no separate asset upload needed.

export const PROFORMA_TEMPLATE = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Proforma Invoice — <%= it.po.metadata.po_id %></title>
<style>
  body { font-family: Helvetica, Arial, sans-serif; color: #222; max-width: 980px; margin: 24px auto; padding: 0 24px; }
  h1 { font-size: 22px; margin: 0; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #222; padding-bottom: 16px; margin-bottom: 24px; }
  .meta { font-size: 13px; line-height: 1.6; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 13px; }
  th, td { border: 1px solid #ccc; padding: 8px 10px; text-align: left; }
  th { background: #f5f5f5; font-weight: 600; }
  td.num { text-align: right; }
  tr.requires-review { background: #fff3cd; font-weight: 600; }
  tr.requires-review td { border-left: 3px solid #ffc107; }
  .badge { padding: 2px 6px; border-radius: 3px; font-size: 11px; font-weight: 600; }
  .badge-ok { background: #d4edda; color: #155724; }
  .badge-review { background: #ffc107; color: #533f03; }
  .totals { margin-top: 24px; text-align: right; font-size: 14px; }
  .totals .row { padding: 4px 0; }
  .totals .grand { font-weight: 700; border-top: 2px solid #222; padding-top: 8px; margin-top: 8px; }
  .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #ccc; font-size: 11px; color: #666; }
  .warning { color: #856404; background: #fff3cd; padding: 8px 12px; border-left: 4px solid #ffc107; margin: 16px 0; font-size: 13px; }
</style>
</head>
<body>

<div class="header">
  <div>
    <h1><%= it.company_name %></h1>
    <div class="meta">Proforma Invoice</div>
  </div>
  <div class="meta">
    <div><strong>Invoice Date:</strong> <%= it.invoice_date %></div>
    <div><strong>PO #:</strong> <%= it.po.metadata.po_id %></div>
    <div><strong>PO Date:</strong> <%= it.po.metadata.po_date || "—" %></div>
  </div>
</div>

<div class="meta">
  <div><strong>Customer:</strong> <%= it.po.metadata.customer_id %></div>
  <div><strong>Delivery:</strong> <%= it.po.metadata.delivery_destination || "—" %></div>
  <div><strong>Consignee:</strong> <%= it.po.metadata.consignee || "—" %></div>
  <div><strong>Currency:</strong> <%= it.po.metadata.currency %></div>
  <div><strong>Payment Terms:</strong> <%= it.po.metadata.payment_method || "—" %></div>
</div>

<% if (it.review_count > 0) { %>
  <div class="warning">
    ⚠ <%= it.review_count %> line item(s) require human review before this invoice can be issued.
  </div>
<% } %>

<table>
  <thead>
    <tr>
      <th>#</th>
      <th>SKU</th>
      <th>Description</th>
      <th class="num">Qty</th>
      <th>Unit</th>
      <th class="num">Unit Price</th>
      <th class="num">Line Total</th>
      <th class="num">CBM</th>
      <th>Status</th>
    </tr>
  </thead>
  <tbody>
    <% it.line_items.forEach(function(item) { %>
      <tr class="<%= item.status_class %>">
        <td><%= item.line_no %></td>
        <td><%= item.sku %></td>
        <td><%= item.description %></td>
        <td class="num"><%= item.quantity %></td>
        <td><%= item.unit %></td>
        <td class="num"><%= it.po.metadata.currency %> <%= item.unit_price.toFixed(2) %></td>
        <td class="num"><%= it.po.metadata.currency %> <%= item.line_total.toFixed(2) %></td>
        <td class="num"><%= item.cbm != null ? item.cbm.toFixed(4) : "—" %></td>
        <td>
          <span class="badge badge-<%= item.requires_review ? 'review' : 'ok' %>"><%= item.status_badge %></span>
          <% if (item.requires_review && item.review_reason) { %>
            <div style="font-size:10px;color:#666;margin-top:2px;"><%= item.review_reason %></div>
          <% } %>
        </td>
      </tr>
    <% }) %>
  </tbody>
</table>

<div class="totals">
  <div class="row">Total Items: <%= it.po.totals.total_items %></div>
  <div class="row">Total CBM: <%= it.po.totals.total_cbm.toFixed(4) %> m³</div>
  <div class="row grand">Subtotal: <%= it.po.metadata.currency %> <%= it.po.totals.total_value.toFixed(2) %></div>
</div>

<div class="footer">
  Generated at <%= it.generated_timestamp %> by OFAEM. This proforma is auto-generated and subject to human sign-off.
</div>

</body>
</html>`;
