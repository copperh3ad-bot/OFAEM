-- Seed sample master_articles for fuzzy matching tests.
-- Run: supabase db query --file scripts/seed_master_articles.sql --linked

INSERT INTO master_articles (sku, description, category, unit, standard_dimensions, brand) VALUES
  ('FAB-001-CHK', 'Checkered Cotton Fabric 58 inches', 'fabric',  'METER', NULL,                                                            'Union Mills'),
  ('FAB-002-STR', 'Striped Polyester Blend 52 inches', 'fabric',  'METER', NULL,                                                            'Union Mills'),
  ('YRN-001-CTN', 'Cotton Yarn 40s Count Natural',     'yarn',    'KG',    '{"length_m":0.5,"width_m":0.5,"height_m":0.5}'::jsonb,         'Coats'),
  ('GAR-001-TSH', 'T-Shirt Adult Large White',         'garment', 'PIECE', '{"length_m":0.4,"width_m":0.3,"height_m":0.1}'::jsonb,         'Union Apparel'),
  ('GAR-002-PNT', 'Trousers Adult Medium Khaki',       'garment', 'PIECE', '{"length_m":0.5,"width_m":0.3,"height_m":0.1}'::jsonb,         'Union Apparel'),
  ('TRI-001-BTN', 'Buttons 4-hole 12mm assorted',      'trim',    'PIECE', '{"length_m":0.012,"width_m":0.012,"height_m":0.003}'::jsonb,   'YKK')
ON CONFLICT (sku) DO UPDATE
SET description         = EXCLUDED.description,
    category            = EXCLUDED.category,
    unit                = EXCLUDED.unit,
    standard_dimensions = EXCLUDED.standard_dimensions,
    brand               = EXCLUDED.brand,
    updated_at          = now();
