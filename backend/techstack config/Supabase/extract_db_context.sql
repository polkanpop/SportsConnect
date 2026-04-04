-- ============================================================
-- SportConnect — Full DB Context Extractor
-- Run each block in Supabase SQL Editor separately,
-- then save each result as its own file in /sql/context/
-- ============================================================


-- ============================================================
-- 1. SCHEMA (all tables + columns + types + defaults)
-- Save as: schema.csv
-- ============================================================
SELECT
  t.table_name,
  c.ordinal_position AS col_order,
  c.column_name,
  c.data_type,
  c.udt_name,                        -- actual enum/custom type name
  c.character_maximum_length,
  c.is_nullable,
  c.column_default,
  c.is_identity,
  c.identity_generation
FROM information_schema.tables t
JOIN information_schema.columns c
  ON c.table_schema = t.table_schema
  AND c.table_name = t.table_name
WHERE t.table_schema = 'public'
  AND t.table_type = 'BASE TABLE'
ORDER BY t.table_name, c.ordinal_position;


-- ============================================================
-- 2. ENUMS (all custom enum types + their values in order)
-- Save as: enums.csv
-- ============================================================
SELECT
  t.typname AS enum_name,
  e.enumsortorder AS value_order,
  e.enumlabel AS value
FROM pg_type t
JOIN pg_enum e ON e.enumtypid = t.oid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public'
ORDER BY t.typname, e.enumsortorder;


-- ============================================================
-- 3. CONSTRAINTS (PK, FK, UNIQUE, CHECK — all in one)
-- Save as: constraints.csv
-- ============================================================
SELECT
  tc.table_name,
  tc.constraint_name,
  tc.constraint_type,
  kcu.column_name,
  -- FK targets
  ccu.table_name  AS foreign_table,
  ccu.column_name AS foreign_column,
  -- CHECK expression
  cc.check_clause
FROM information_schema.table_constraints tc
LEFT JOIN information_schema.key_column_usage kcu
  ON kcu.constraint_name = tc.constraint_name
  AND kcu.table_schema = tc.table_schema
LEFT JOIN information_schema.constraint_column_usage ccu
  ON ccu.constraint_name = tc.constraint_name
  AND ccu.table_schema = tc.table_schema
  AND tc.constraint_type = 'FOREIGN KEY'
LEFT JOIN information_schema.check_constraints cc
  ON cc.constraint_name = tc.constraint_name
  AND cc.constraint_schema = tc.table_schema
WHERE tc.table_schema = 'public'
ORDER BY tc.table_name, tc.constraint_type, tc.constraint_name;


-- ============================================================
-- 4. INDEXES (all indexes including GIN, GiST, btree)
-- Save as: indexes.csv
-- ============================================================
SELECT
  schemaname,
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
ORDER BY tablename, indexname;


-- ============================================================
-- 5. FUNCTIONS & RPCs (all public functions + full source)
-- Save as: functions.csv
-- ============================================================
SELECT
  p.proname AS function_name,
  pg_get_function_arguments(p.oid) AS arguments,
  pg_get_function_result(p.oid) AS return_type,
  l.lanname AS language,
  p.prosrc AS source_body,
  pg_get_functiondef(p.oid) AS full_definition
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_language l ON l.oid = p.prolang
WHERE n.nspname = 'public'
  AND p.prokind = 'f'               -- functions only (not aggregates)
ORDER BY p.proname;


-- ============================================================
-- 6. TRIGGERS (which table, which function, when it fires)
-- Save as: triggers.csv
-- ============================================================
SELECT
  trigger_name,
  event_object_table AS table_name,
  event_manipulation AS trigger_event,  -- INSERT / UPDATE / DELETE
  action_timing,                         -- BEFORE / AFTER
  action_statement,
  action_orientation                     -- ROW / STATEMENT
FROM information_schema.triggers
WHERE trigger_schema = 'public'
ORDER BY event_object_table, trigger_name;


-- ============================================================
-- 7. VIEWS
-- Save as: views.csv
-- ============================================================
SELECT
  table_name AS view_name,
  view_definition
FROM information_schema.views
WHERE table_schema = 'public'
ORDER BY table_name;


-- ============================================================
-- 8. RLS POLICIES (Row Level Security)
-- Save as: rls_policies.csv
-- ============================================================
SELECT
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,       -- SELECT / INSERT / UPDATE / DELETE / ALL
  qual,      -- USING expression
  with_check
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;


-- ============================================================
-- 9. SEQUENCES
-- Save as: sequences.csv
-- ============================================================
SELECT
  sequence_name,
  data_type,
  start_value,
  minimum_value,
  maximum_value,
  increment,
  cycle_option
FROM information_schema.sequences
WHERE sequence_schema = 'public'
ORDER BY sequence_name;


-- ============================================================
-- 10. EXTENSIONS
-- Save as: extensions.csv
-- ============================================================
SELECT
  extname AS extension_name,
  extversion AS version,
  n.nspname AS schema
FROM pg_extension e
JOIN pg_namespace n ON n.oid = e.extnamespace
ORDER BY extname;


-- ============================================================
-- 11. FOREIGN KEY MAP (clean FK dependency graph)
-- Save as: fk_map.csv
-- ============================================================
SELECT
  tc.table_name        AS from_table,
  kcu.column_name      AS from_column,
  ccu.table_name       AS to_table,
  ccu.column_name      AS to_column,
  tc.constraint_name,
  rc.update_rule,
  rc.delete_rule
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON kcu.constraint_name = tc.constraint_name
  AND kcu.table_schema = tc.table_schema
JOIN information_schema.constraint_column_usage ccu
  ON ccu.constraint_name = tc.constraint_name
  AND ccu.table_schema = tc.table_schema
JOIN information_schema.referential_constraints rc
  ON rc.constraint_name = tc.constraint_name
  AND rc.constraint_schema = tc.table_schema
WHERE tc.table_schema = 'public'
  AND tc.constraint_type = 'FOREIGN KEY'
ORDER BY from_table, from_column;


-- ============================================================
-- 12. UNIQUE CONSTRAINTS (standalone, not via PK)
-- Save as: unique_constraints.csv
-- ============================================================
SELECT
  tc.table_name,
  tc.constraint_name,
  string_agg(kcu.column_name, ', ' ORDER BY kcu.ordinal_position) AS columns
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON kcu.constraint_name = tc.constraint_name
  AND kcu.table_schema = tc.table_schema
WHERE tc.table_schema = 'public'
  AND tc.constraint_type = 'UNIQUE'
GROUP BY tc.table_name, tc.constraint_name
ORDER BY tc.table_name, tc.constraint_name;


-- ============================================================
-- 13. TABLE STORAGE & RLS ENABLED STATUS
-- Save as: table_meta.csv
-- ============================================================
SELECT
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  c.relforcerowsecurity AS rls_forced,
  c.reltuples::bigint AS estimated_row_count,
  pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
ORDER BY c.relname;
