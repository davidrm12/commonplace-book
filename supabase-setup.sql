-- ============================================
-- Commonplace Book — Supabase Table Setup
-- Run this in the Supabase SQL Editor
-- ============================================

-- Create the entries table
CREATE TABLE IF NOT EXISTS entries (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('Quotes', 'Ideas', 'References', 'Reflections', 'Frameworks')),
  source TEXT DEFAULT '',
  content TEXT NOT NULL,
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_entries_category ON entries(category);
CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at DESC);

-- Enable Row Level Security
ALTER TABLE entries ENABLE ROW LEVEL SECURITY;

-- Allow public read/write via anon key (single-user app)
-- Adjust these policies if you add authentication later
CREATE POLICY "Allow public read" ON entries
  FOR SELECT USING (true);

CREATE POLICY "Allow public insert" ON entries
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow public update" ON entries
  FOR UPDATE USING (true);

CREATE POLICY "Allow public delete" ON entries
  FOR DELETE USING (true);

-- Auto-update updated_at on changes
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER entries_updated_at
  BEFORE UPDATE ON entries
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
