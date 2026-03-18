-- ============================================
-- Commonplace Book — Supabase Table Setup v2
-- WITH AUTHENTICATION & LOCKED-DOWN RLS
-- Run this in the Supabase SQL Editor
-- ============================================

-- STEP 1: Drop old open policies (if they exist from v1)
DROP POLICY IF EXISTS "Allow public read" ON entries;
DROP POLICY IF EXISTS "Allow public insert" ON entries;
DROP POLICY IF EXISTS "Allow public update" ON entries;
DROP POLICY IF EXISTS "Allow public delete" ON entries;

-- STEP 2: Create the entries table (if not already created)
CREATE TABLE IF NOT EXISTS entries (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL DEFAULT auth.uid(),
  title TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('Quotes', 'Ideas', 'References', 'Reflections', 'Frameworks')),
  source TEXT DEFAULT '',
  content TEXT NOT NULL,
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- If table already exists but lacks user_id column, add it:
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'entries' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE entries ADD COLUMN user_id UUID DEFAULT auth.uid();
  END IF;
END$$;

-- STEP 3: Create indexes
CREATE INDEX IF NOT EXISTS idx_entries_category ON entries(category);
CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_user_id ON entries(user_id);

-- STEP 4: Enable Row Level Security
ALTER TABLE entries ENABLE ROW LEVEL SECURITY;

-- STEP 5: Create LOCKED-DOWN policies — only the authenticated owner can access their rows
CREATE POLICY "Users can read own entries" ON entries
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own entries" ON entries
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own entries" ON entries
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own entries" ON entries
  FOR DELETE USING (auth.uid() = user_id);

-- STEP 6: Auto-update updated_at on changes
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
