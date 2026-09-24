# Commonplace Book

A curated collection of enduring ideas — quotes, frameworks, reflections, and more.

Static site for GitHub Pages with Supabase backend and authentication.

## Setup

### 1. Supabase
1. Open your Supabase project SQL Editor
2. Run `supabase-setup.sql` to create the `entries` and `categories` tables with **locked-down RLS policies**
   - The script is idempotent: re-run it after pulling updates. Existing entries are kept.
   - Until it has been run, the app still works with the built-in categories, but category editing is disabled.
3. The anon key is already in `app.js` — this is safe to expose publicly (RLS protects your data)

### 2. Create your account
1. Deploy the site (see below)
2. Visit the site and click "Create one" to sign up with email + password
3. All entries are tied to your authenticated user ID — nobody else can see or modify them

### 3. GitHub Pages
1. Push this repo to GitHub
2. Settings → Pages → Source: Deploy from branch (`main`, root `/`)
3. Site goes live at `https://<username>.github.io/commonplace-book/`

## Security Model
- **Supabase Auth** — email/password authentication
- **Row Level Security** — every entry and category has a `user_id`; RLS policies restrict all CRUD to `auth.uid() = user_id`
- **Category RPCs** (`rename_category`, `delete_category`) run as the calling user (`SECURITY INVOKER`), so RLS still applies
- **Anon key is public by design** — it only identifies the project; RLS enforces data isolation
- **No one can see your entries** without your login credentials, even if they find the Supabase URL

## Features
- Per-user categories: starts with Quotes, Ideas, References, Reflections, Frameworks, Analyze, Other — add, rename, recolor or delete them (entries in a deleted category are moved, never lost)
- Unsaved-entry drafts: closing the entry dialog (click outside, ×, Esc) keeps what you typed until the page is reloaded; "Discard" clears it
- Full-text search across titles, content, sources, tags
- Filter by category, sort by date/alpha/category
- Multi-select with bulk delete, export, copy
- Copy for Claude (structured `<context>` block)
- JSON import and export
- Responsive design (mobile-friendly: long URLs/words wrap, card actions always visible on touch screens)
- Session persistence (stays logged in)
