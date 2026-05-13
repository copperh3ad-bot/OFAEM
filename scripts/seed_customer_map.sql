-- Seed customer_email_map with a handful of canonical buyer mappings.
-- These let the ingest-email customer-resolver collapse multiple buyer
-- addresses onto a single customer_id, instead of falling back to the
-- domain (which conflates corporate buyers and personal accounts).
--
-- Run via: psql ... -f scripts/seed_customer_map.sql
--          OR: cat scripts/seed_customer_map.sql | supabase db query --linked

INSERT INTO customer_email_map (email_pattern, pattern_type, customer_id) VALUES
  ('hm.com',                  'domain', 'HM_GROUP'),
  ('inditex.com',             'domain', 'INDITEX'),
  ('zara.com',                'domain', 'INDITEX'),
  ('bershka.com',             'domain', 'INDITEX'),
  ('cottonon.com',            'domain', 'COTTON_ON'),
  ('uniqlo.com',              'domain', 'UNIQLO'),
  ('next.co.uk',              'domain', 'NEXT_PLC'),
  ('buyer@indie-fashion.shop','exact',  'INDIE_FASHION'),
  ('orders@boutique-x.co',    'exact',  'BOUTIQUE_X')
ON CONFLICT (email_pattern, pattern_type) DO UPDATE
  SET customer_id = EXCLUDED.customer_id;
