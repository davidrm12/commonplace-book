# Commonplace Book

A curated collection of enduring ideas — quotes, frameworks, reflections, and more.

Built as a static site for GitHub Pages with a Supabase backend.

## Setup

### 1. Supabase
1. Open your Supabase project SQL Editor
2. Run `supabase-setup.sql` to create the `entries` table and RLS policies
3. Update `app.js` with your actual project URL and anon key

### 2. GitHub Pages
1. Push this repo to GitHub
2. Go to Settings → Pages → Source: Deploy from branch (`main`, root `/`)
3. Your site will be live at `https://<username>.github.io/commonplace-book/`

## Features
- **Five categories**: Quotes, Ideas, References, Reflections, Frameworks
- **Search**: Full-text search across titles, content, sources, tags
- **Filter & Sort**: By category, date, alphabetical
- **Select & Bulk Actions**: Multi-select with bulk delete, export, copy
- **Copy for Claude**: Format selected entries as structured context for Claude
- **Import/Export**: JSON import and export
- **Responsive**: Works on desktop and mobile

## Tech Stack
- Vanilla HTML/CSS/JS (no build step)
- Google Fonts: Libre Baskerville + DM Sans
- Supabase REST API (no client library)
