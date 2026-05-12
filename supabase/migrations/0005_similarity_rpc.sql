-- 0005_similarity_rpc.sql
-- Trigram-based candidate retrieval for AI SKU matching.
-- Returns top-k master_articles ranked by pg_trgm similarity against a query string.
-- The GIN index from 0001 on description gin_trgm_ops powers this.

CREATE OR REPLACE FUNCTION find_similar_articles(
  query_text TEXT,
  match_limit INT DEFAULT 10,
  min_similarity REAL DEFAULT 0.10
)
RETURNS TABLE (
  sku                 TEXT,
  description         TEXT,
  category            TEXT,
  unit                TEXT,
  standard_dimensions JSONB,
  similarity          REAL
)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    m.sku,
    m.description,
    m.category,
    m.unit,
    m.standard_dimensions,
    GREATEST(
      similarity(m.description, query_text),
      similarity(m.sku, query_text)
    ) AS similarity
  FROM master_articles m
  WHERE m.is_active = true
    AND (
      m.description % query_text
      OR m.sku % query_text
      OR similarity(m.description, query_text) >= min_similarity
    )
  ORDER BY similarity DESC
  LIMIT match_limit;
$$;

-- Allow authenticated users and the service role to call this
GRANT EXECUTE ON FUNCTION find_similar_articles(TEXT, INT, REAL) TO authenticated, service_role;

-- Note: the % operator defaults to similarity_threshold=0.3 on Supabase.
-- We supplement it with an explicit similarity(...) >= min_similarity check in
-- the WHERE clause so callers can pass a lower threshold without ALTERing the GUC.
