# OFAEM Review UI — Deployment

The `web/` directory is a Vite + React + TypeScript + Tailwind app providing the
human review interface for OFAEM. It talks directly to Supabase via the public
anon key plus the authenticated user's session JWT.

## Local development

```bash
cd ~/Code/OFAEM/web
npm install
cp .env.example .env.local   # already done once; edit if creds change
npm run dev
```

Open http://localhost:5173 (or whatever port Vite picks).

## Required Supabase users

The login form expects users provisioned in Supabase Auth with a matching row
in `public.user_profiles`. To bootstrap an Owner:

```bash
# 1. Create the auth user
SVC_KEY=$(supabase projects api-keys --project-ref ouxnplyjzlbhmvpcvjmx | grep service_role | awk -F'|' '{print $2}' | tr -d ' ')
curl -X POST "https://ouxnplyjzlbhmvpcvjmx.supabase.co/auth/v1/admin/users" \
  -H "Authorization: Bearer $SVC_KEY" -H "apikey: $SVC_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"owner@unionfabrics.com","password":"<strong>","email_confirm":true}'
# → returns { "id": "<uuid>" }

# 2. Insert the profile row with the role
echo "INSERT INTO user_profiles (id, email, full_name, role, is_active) \
      VALUES ('<uuid>', 'owner@unionfabrics.com', 'Owner Name', 'Owner', true);" \
  | supabase db query --linked
```

Roles: `Owner`, `Manager`, `Merchandiser`, `Viewer`, `Supplier`, `QC Inspector`.
RLS in the existing migrations decides what each role can see/do.

## Production build

```bash
npm run build
# Output: dist/
```

## Deploy options

### Netlify (recommended — matches MerQuant)

```bash
cd ~/Code/OFAEM/web
npm install -g netlify-cli   # if needed
netlify init                  # creates a new site
netlify deploy --prod         # builds + deploys
```

Set the two environment variables in the Netlify dashboard:
- `VITE_SUPABASE_URL`     = `https://ouxnplyjzlbhmvpcvjmx.supabase.co`
- `VITE_SUPABASE_ANON_KEY` = (the anon JWT from `supabase projects api-keys`)

Add a redirect rule for client-side routing (`netlify.toml`):
```toml
[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

### Vercel

```bash
npm install -g vercel
cd ~/Code/OFAEM/web
vercel
# follow prompts, set env vars at the end
```

### Supabase Static Hosting

Not yet supported on Supabase as of this writing. Use Netlify or Vercel.

## Pages

| Route | Purpose |
|---|---|
| `/login` | Email/password sign-in |
| `/` | Dashboard with workflow_state stage counts + review queue size + recent POs |
| `/review` | Queue of POs with requires_review=true |
| `/orders` | Searchable table of all current-version POs |
| `/orders/:id` | PO detail: editable line items, active crises, revision diff, sign-off button |
| `/crises` | All active crises with LLM-generated mitigation plans |

## Editing flow & ML feedback

When a reviewer edits a line item field and clicks Save:
1. The patched line item is merged into the existing `payload.line_items` array.
2. The PO totals (value, CBM, items_requiring_review) are recomputed.
3. `requires_review` flag is cleared on the edited row; if any other row still
   requires review, the PO's overall flag stays true.
4. `ai_extractions` row is updated with `reviewed_by` + `reviewed_at`.
5. One `ml_feedback` row is inserted **per changed field** capturing the
   original value, the corrected value, and full context — this is the
   training dataset for future prompt-engineering / model fine-tuning.

## Sign-off

The "Sign off as ready for invoicing" button is gated client-side (Owner/Manager
roles only). The server-side enforcement is the
`fn_enforce_proforma_signoff_role` Postgres trigger from migration 0003, which
fires when `proforma_invoices.is_ready_for_invoicing` flips true. The current
UI only updates `ai_extractions.is_ready_for_invoicing` for now — wire it to
proforma_invoices when invoicing UX is added.

## Known follow-ups

- No magic-link or SSO login yet (email/password only)
- No real-time updates — pages refetch on mount; consider Supabase Realtime
- No bulk-edit / approve-all
- No keyboard navigation between rows
- Crisis resolution uses `window.prompt` for notes — replace with proper modal
