-- ============================================
-- Commonplace Book — Supabase Setup v3
-- Authentication, locked-down RLS, per-user categories
-- Run this in the Supabase SQL Editor.
-- Safe to re-run: every step is idempotent and existing data is kept.
-- ============================================

-- STEP 1: Drop old open policies (if they exist from v1)
DROP POLICY IF EXISTS "Allow public read" ON entries;
DROP POLICY IF EXISTS "Allow public insert" ON entries;
DROP POLICY IF EXISTS "Allow public update" ON entries;
DROP POLICY IF EXISTS "Allow public delete" ON entries;

-- STEP 2: Entries table
CREATE TABLE IF NOT EXISTS entries (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL DEFAULT auth.uid(),
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  source TEXT DEFAULT '',
  content TEXT NOT NULL,
  tags TEXT[] DEFAULT '{}',
  starred BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Bring older versions of the table up to date
ALTER TABLE entries ADD COLUMN IF NOT EXISTS user_id UUID DEFAULT auth.uid();
ALTER TABLE entries ADD COLUMN IF NOT EXISTS starred BOOLEAN NOT NULL DEFAULT false;

-- Categories are now user-defined, so remove the old hard-coded
-- CHECK (category IN (...)) constraint, whatever it was named.
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.entries'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%category%'
  LOOP
    EXECUTE format('ALTER TABLE public.entries DROP CONSTRAINT %I', c.conname);
  END LOOP;
END$$;

CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_user_id ON entries(user_id);
-- Replaces the single-column category index: lookups are always per user
DROP INDEX IF EXISTS idx_entries_category;
CREATE INDEX IF NOT EXISTS idx_entries_user_category ON entries(user_id, category);

ALTER TABLE entries ENABLE ROW LEVEL SECURITY;

-- Table privileges for the API roles. RLS below still limits rows to their owner.
-- (Newer Supabase projects no longer grant these automatically for tables made in SQL.)
REVOKE ALL ON entries FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON entries TO authenticated;

DROP POLICY IF EXISTS "Users can read own entries" ON entries;
DROP POLICY IF EXISTS "Users can insert own entries" ON entries;
DROP POLICY IF EXISTS "Users can update own entries" ON entries;
DROP POLICY IF EXISTS "Users can delete own entries" ON entries;

CREATE POLICY "Users can read own entries" ON entries
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own entries" ON entries
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own entries" ON entries
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own entries" ON entries
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Auto-update updated_at on changes
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS entries_updated_at ON entries;
CREATE TRIGGER entries_updated_at
  BEFORE UPDATE ON entries
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- STEP 3: Per-user categories
-- Each user gets their own list. The app seeds the defaults
-- (Quotes, Ideas, References, Reflections, Frameworks, Analyze, Other)
-- the first time a user signs in with an empty list.
CREATE TABLE IF NOT EXISTS categories (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  color TEXT NOT NULL DEFAULT '#6b7280' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  position INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, name)
);

ALTER TABLE categories ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON categories FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON categories TO authenticated;

DROP POLICY IF EXISTS "Users can read own categories" ON categories;
DROP POLICY IF EXISTS "Users can insert own categories" ON categories;
DROP POLICY IF EXISTS "Users can update own categories" ON categories;
DROP POLICY IF EXISTS "Users can delete own categories" ON categories;

CREATE POLICY "Users can read own categories" ON categories
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own categories" ON categories
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own categories" ON categories
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own categories" ON categories
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- STEP 4: Rename / delete a category together with its entries, in one transaction.
-- SECURITY INVOKER keeps RLS in force: a user can only touch their own rows.
CREATE OR REPLACE FUNCTION rename_category(p_id UUID, p_name TEXT, p_color TEXT)
RETURNS categories
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  old_name TEXT;
  result categories;
BEGIN
  SELECT name INTO old_name FROM categories WHERE id = p_id AND user_id = auth.uid();
  IF old_name IS NULL THEN
    RAISE EXCEPTION 'Category not found';
  END IF;

  UPDATE categories SET name = btrim(p_name), color = p_color
  WHERE id = p_id
  RETURNING * INTO result;

  IF result.name <> old_name THEN
    UPDATE entries SET category = result.name
    WHERE user_id = auth.uid() AND category = old_name;
  END IF;

  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION delete_category(p_id UUID, p_move_to TEXT)
RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  old_name TEXT;
BEGIN
  SELECT name INTO old_name FROM categories WHERE id = p_id AND user_id = auth.uid();
  IF old_name IS NULL THEN
    RAISE EXCEPTION 'Category not found';
  END IF;

  IF EXISTS (SELECT 1 FROM entries WHERE user_id = auth.uid() AND category = old_name) THEN
    IF p_move_to IS NULL OR NOT EXISTS (
      SELECT 1 FROM categories WHERE user_id = auth.uid() AND name = p_move_to AND id <> p_id
    ) THEN
      RAISE EXCEPTION 'A valid destination category is required for this category''s entries';
    END IF;
    UPDATE entries SET category = p_move_to
    WHERE user_id = auth.uid() AND category = old_name;
  END IF;

  DELETE FROM categories WHERE id = p_id;
END;
$$;

REVOKE ALL ON FUNCTION rename_category(UUID, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION delete_category(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION rename_category(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION delete_category(UUID, TEXT) TO authenticated;

-- Make PostgREST pick up the new table and functions immediately
NOTIFY pgrst, 'reload schema';
