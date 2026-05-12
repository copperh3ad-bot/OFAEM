-- 0001_core_schema.sql
-- Core tables for OFAEM: user_profiles (auth-linked), master_articles, ai_extractions

CREATE TABLE IF NOT EXISTS user_profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT UNIQUE NOT NULL,
  full_name   TEXT,
  role        TEXT NOT NULL DEFAULT 'Viewer'
              CHECK (role IN ('Owner','Manager','Merchandiser','Viewer','Supplier','QC Inspector')),
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_role ON user_profiles(role);

CREATE TABLE IF NOT EXISTS master_articles (
  sku                  TEXT PRIMARY KEY,
  description          TEXT NOT NULL,
  category             TEXT CHECK (category IN ('fabric','yarn','garment','trim','unknown')),
  unit                 TEXT NOT NULL CHECK (unit IN ('METER','YARD','KG','PIECE','ROLL','BOX','BOLT','LITER')),
  standard_dimensions  JSONB,
  default_packaging    TEXT,
  brand                TEXT,
  is_active            BOOLEAN DEFAULT true,
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_master_articles_category ON master_articles(category);
CREATE INDEX IF NOT EXISTS idx_master_articles_description_trgm
  ON master_articles USING GIN (description gin_trgm_ops);

-- Required extension for trigram description search (used by RAG retrieval)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS ai_extractions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                  TEXT NOT NULL CHECK (kind IN ('purchase_order','tech_pack','master_data')),
  customer_id           TEXT,
  source_type           TEXT NOT NULL CHECK (source_type IN ('PDF','IMAGE','EXCEL','EMAIL','MANUAL')),
  raw_content           TEXT,
  payload               JSONB NOT NULL,
  model_used            TEXT,
  overall_confidence    NUMERIC(4,3),
  is_ready_for_invoicing BOOLEAN DEFAULT false,
  reviewed_by           UUID REFERENCES auth.users(id),
  reviewed_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_extractions_kind ON ai_extractions(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_extractions_customer ON ai_extractions(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_extractions_payload_po_id
  ON ai_extractions((payload->'metadata'->>'po_id'));
