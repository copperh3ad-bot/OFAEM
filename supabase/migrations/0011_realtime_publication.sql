-- 0011_realtime_publication.sql
-- Adds the workflow tables to the supabase_realtime publication so the
-- React UI can subscribe via postgres_changes WebSocket events.
--
-- IDEMPOTENT: each ALTER PUBLICATION ADD TABLE is wrapped in a guard so
-- re-applying the migration is a no-op.

DO $$
DECLARE
  t TEXT;
  publication_exists BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ) INTO publication_exists;

  -- Bootstrap a publication if one doesn't already exist (unusual on Supabase, where
  -- the platform creates supabase_realtime by default — but make the migration safe
  -- to run on a fresh local dev project too).
  IF NOT publication_exists THEN
    EXECUTE 'CREATE PUBLICATION supabase_realtime';
  END IF;

  FOREACH t IN ARRAY ARRAY[
    'ai_extractions',
    'crisis_alerts',
    'proforma_invoices',
    'logistical_plans',
    'production_schedules',
    'compliance_records',
    'email_ingest_log'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;
