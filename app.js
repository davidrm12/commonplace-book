/* ============================================
   COMMONPLACE BOOK — Application Logic v3
   Supabase Auth + locked-down RLS + per-user categories
   ============================================ */

const SUPABASE_URL = 'https://llmtqxtcpmrgwkfpudnw.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxsbXRxeHRjcG1yZ3drZnB1ZG53Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4NTM1NTAsImV4cCI6MjA4OTQyOTU1MH0.BSCvcNFKSnZDZCqDtHqoLkUBUYlRUQx6VY9-vydFnH8';

// Seeded into a user's category list the first time they have none
const DEFAULT_CATEGORIES = [
  { name: 'Quotes',      color: '#8b4513' },
  { name: 'Ideas',       color: '#2e7d5b' },
  { name: 'References',  color: '#4a6fa5' },
  { name: 'Reflections', color: '#7b5ea7' },
  { name: 'Frameworks',  color: '#c17817' },
  { name: 'Analyze',     color: '#b45309' },
  { name: 'Other',       color: '#6b7280' },
];
// Suggested colors for new categories (cycled)
const CATEGORY_PALETTE = ['#4a6fa5', '#2e7d5b', '#7b5ea7', '#c17817', '#a63d2f', '#0f766e', '#be185d', '#8b4513', '#4d7c0f', '#6b7280'];
const FALLBACK_COLOR = '#6b7280';
const CATEGORY_MAX_LENGTH = 40;

let accessToken = null;
let currentUser = null;

// ---- Auth ----
async function authPost(path, body, fallbackMsg) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, { method: 'POST', headers: { 'apikey': SUPABASE_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error?.message || data.error_description || data.msg || fallbackMsg);
  return data;
}

const auth = {
  refreshing: null,
  signUp(email, password) { return authPost('signup', { email, password }, 'Signup failed'); },
  signIn(email, password) { return authPost('token?grant_type=password', { email, password }, 'Login failed'); },
  refreshToken(rt) { return authPost('token?grant_type=refresh_token', { refresh_token: rt }, 'Session expired — please sign in again'); },
  async getUser(token) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${token}` } });
    if (!res.ok) throw new Error('Could not fetch user');
    return res.json();
  },
  saveSession(data) {
    accessToken = data.access_token;
    if (data.user) currentUser = data.user;
    localStorage.setItem('sb_access_token', data.access_token);
    localStorage.setItem('sb_refresh_token', data.refresh_token);
    localStorage.setItem('sb_expires_at', Date.now() + (data.expires_in * 1000));
  },
  clearSession() {
    accessToken = null; currentUser = null;
    localStorage.removeItem('sb_access_token');
    localStorage.removeItem('sb_refresh_token');
    localStorage.removeItem('sb_expires_at');
  },
  // Concurrent 401s share a single refresh so the rotating refresh token is only spent once
  refresh() {
    if (!this.refreshing) {
      const rt = localStorage.getItem('sb_refresh_token');
      this.refreshing = (rt ? this.refreshToken(rt).then(data => { this.saveSession(data); return true; }) : Promise.resolve(false))
        .catch(() => false)
        .finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  },
  async restoreSession() {
    const token = localStorage.getItem('sb_access_token');
    const refresh = localStorage.getItem('sb_refresh_token');
    const expiresAt = parseInt(localStorage.getItem('sb_expires_at') || '0', 10);
    if (!token || !refresh) return false;
    if (Date.now() > expiresAt - 60000) {
      if (await this.refresh()) return true;
      this.clearSession(); return false;
    }
    accessToken = token;
    try { currentUser = await this.getUser(token); return true; }
    catch { this.clearSession(); return false; }
  }
};

// ---- DB ----
class DbError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

const db = {
  async request(method, path, body = null, prefer = null) {
    if (!accessToken) throw new Error('Not authenticated');
    const send = () => {
      const headers = { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
      if (prefer) headers['Prefer'] = prefer;
      else if (method === 'POST' || method === 'PATCH') headers['Prefer'] = 'return=representation';
      return fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    };
    let res = await send();
    if (res.status === 401) {
      if (!(await auth.refresh())) { auth.clearSession(); resetAppState(); showAuthScreen(); throw new Error('Session expired — please sign in again'); }
      res = await send();
    }
    const text = await res.text();
    if (!res.ok) {
      let info = {};
      try { info = JSON.parse(text); } catch { /* non-JSON error body */ }
      throw new DbError(info.message || `${method} ${path}: ${res.status} — ${text}`, res.status, info.code);
    }
    return text ? JSON.parse(text) : null;
  },
  fetchAll() { return this.request('GET', 'entries?select=*&order=created_at.desc'); },
  async insert(entry) { const rows = await this.request('POST', 'entries', { ...entry, user_id: currentUser.id }); return rows?.[0] || rows; },
  insertMany(list) { return this.request('POST', 'entries', list.map(e => ({ ...e, user_id: currentUser.id }))); },
  async update(id, updates) { const rows = await this.request('PATCH', `entries?id=eq.${encodeURIComponent(id)}`, updates); return rows?.[0] || rows; },
  remove(id) { return this.request('DELETE', `entries?id=eq.${encodeURIComponent(id)}`); },
  removeMany(ids) { return this.request('DELETE', `entries?id=in.(${ids.map(encodeURIComponent).join(',')})`); },

  fetchCategories() { return this.request('GET', 'categories?select=*&order=position.asc,created_at.asc'); },
  // Ignores duplicates so two tabs seeding at once can't collide
  insertCategories(list) {
    return this.request('POST', 'categories?on_conflict=user_id,name', list.map(c => ({ ...c, user_id: currentUser.id })), 'resolution=ignore-duplicates,return=representation');
  },
  renameCategory(id, name, color) { return this.request('POST', 'rpc/rename_category', { p_id: id, p_name: name, p_color: color }); },
  deleteCategory(id, moveTo) { return this.request('POST', 'rpc/delete_category', { p_id: id, p_move_to: moveTo }); },
};

// Table or RPC missing: the Supabase migration hasn't been run yet
function isMissingSchemaError(err) {
  return err instanceof DbError && (err.status === 404 || ['PGRST202', 'PGRST205', '42P01', '42883'].includes(err.code));
}

// ---- State ----
let entries = [];
let categories = [];            // [{ id, name, color, position }]
let categoriesManaged = true;   // false when the categories table doesn't exist yet
let selectedIds = new Set();
let editingId = null;
let deleteTarget = null;
let categoryDeleteTarget = null;
let starFilterActive = false;
let saving = false;

// Unsaved modal contents, keyed by entry id ('new' for a new entry).
// In-memory only: lost on reload, which is intentional.
const drafts = new Map();
let modalBaseline = null;

// Pre-shuffled entry id -> position; regenerated on demand
let randomRank = new Map();

const $ = (sel) => document.querySelector(sel);
const authScreen = $('#auth-screen');
const appShell = $('#app-shell');
const grid = $('#entries-grid');
const emptyState = $('#empty-state');
const loadingState = $('#loading-state');
const entryModal = $('#entry-modal');
const deleteModal = $('#delete-modal');
const categoryModal = $('#category-modal');
const categoryDeleteModal = $('#category-delete-modal');
const searchInput = $('#search-input');
const filterCategory = $('#filter-category');
const entryCategory = $('#entry-category');
const sortBy = $('#sort-by');
const selectionControls = $('#selection-controls');
const selectionCount = $('#selection-count');
const statsBar = $('#stats-bar');
const toast = $('#toast');
const btnStarFilter = $('#btn-star-filter');
const btnReshuffle = $('#btn-reshuffle');
const btnNewEntry = $('#btn-new-entry');
const categoryList = $('#category-list');

let toastTimer;
function showToast(msg) { toast.textContent = msg; toast.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('visible'), 2600); }

function isOpen(modal) { return modal.style.display === 'flex'; }
function openOverlay(modal) { modal.style.display = 'flex'; document.body.classList.add('modal-open'); }
function closeOverlay(modal) {
  modal.style.display = 'none';
  if (![entryModal, deleteModal, categoryModal, categoryDeleteModal].some(isOpen)) document.body.classList.remove('modal-open');
}

// ---- True random shuffle using Fisher-Yates + Math.random ----
function shuffleArray(arr) {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function generateRandomOrder() {
  randomRank = new Map(shuffleArray(entries.map(e => e.id)).map((id, idx) => [id, idx]));
}

// ---- Auth UI ----
function showAuthScreen() { authScreen.style.display = 'flex'; appShell.style.display = 'none'; }
function showApp() { authScreen.style.display = 'none'; appShell.style.display = 'block'; if (currentUser) $('#user-email').textContent = currentUser.email || ''; }
function showAuthError(msg) { const el = $('#auth-error'); el.textContent = msg; el.style.display = 'block'; $('#auth-success').style.display = 'none'; }
function showAuthSuccess(msg) { const el = $('#auth-success'); el.textContent = msg; el.style.display = 'block'; $('#auth-error').style.display = 'none'; }
function clearAuthMessages() { $('#auth-error').style.display = 'none'; $('#auth-success').style.display = 'none'; }

function resetAppState() {
  entries = []; categories = []; selectedIds.clear(); drafts.clear(); editingId = null;
  [entryModal, deleteModal, categoryModal, categoryDeleteModal].forEach(closeOverlay);
  btnNewEntry.classList.remove('has-draft');
}

$('#link-to-signup').addEventListener('click', (e) => { e.preventDefault(); clearAuthMessages(); $('#auth-login').style.display = 'none'; $('#auth-signup').style.display = 'block'; });
$('#link-to-login').addEventListener('click', (e) => { e.preventDefault(); clearAuthMessages(); $('#auth-signup').style.display = 'none'; $('#auth-login').style.display = 'block'; });

$('#btn-signup').addEventListener('click', async () => {
  const email = $('#signup-email').value.trim(); const password = $('#signup-password').value; clearAuthMessages();
  if (!email || !password) { showAuthError('Email and password are required'); return; }
  if (password.length < 6) { showAuthError('Password must be at least 6 characters'); return; }
  $('#btn-signup').disabled = true; $('#btn-signup').textContent = 'Creating…';
  try { const data = await auth.signUp(email, password); if (data.access_token) { auth.saveSession(data); showApp(); loadData(); } else { showAuthSuccess('Account created! Check your email to confirm, then sign in.'); $('#auth-signup').style.display = 'none'; $('#auth-login').style.display = 'block'; } }
  catch (err) { showAuthError(err.message); }
  finally { $('#btn-signup').disabled = false; $('#btn-signup').textContent = 'Create Account'; }
});

$('#btn-login').addEventListener('click', async () => {
  const email = $('#login-email').value.trim(); const password = $('#login-password').value; clearAuthMessages();
  if (!email || !password) { showAuthError('Email and password are required'); return; }
  $('#btn-login').disabled = true; $('#btn-login').textContent = 'Signing in…';
  try { const data = await auth.signIn(email, password); auth.saveSession(data); showApp(); loadData(); }
  catch (err) { showAuthError(err.message); }
  finally { $('#btn-login').disabled = false; $('#btn-login').textContent = 'Sign In'; }
});

$('#login-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-login').click(); });
$('#signup-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-signup').click(); });
$('#btn-logout').addEventListener('click', () => { auth.clearSession(); resetAppState(); showAuthScreen(); showToast('Signed out'); });

// ---- Categories ----
function safeColor(c) { return /^#[0-9a-f]{6}$/i.test(c || '') ? c : FALLBACK_COLOR; }
function categoryColor(name) { return safeColor(categories.find(c => c.name === name)?.color); }
function findCategory(name) { const n = name.trim().toLowerCase(); return categories.find(c => c.name.toLowerCase() === n); }
function nextPaletteColor() { return CATEGORY_PALETTE[categories.length % CATEGORY_PALETTE.length]; }

function renderCategoryOptions() {
  const options = categories.map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
  const currentFilter = filterCategory.value;
  filterCategory.innerHTML = `<option value="all">All Categories</option>${options}`;
  filterCategory.value = categories.some(c => c.name === currentFilter) ? currentFilter : 'all';
  const currentEntry = entryCategory.value;
  entryCategory.innerHTML = options;
  if (currentEntry && categories.some(c => c.name === currentEntry)) entryCategory.value = currentEntry;
}

async function loadCategories() {
  let rows;
  try {
    rows = await db.fetchCategories() || [];
    categoriesManaged = true;
  } catch (err) {
    if (!isMissingSchemaError(err)) throw err;
    // Migration not run yet: keep the app usable with the built-in list
    console.warn('categories table not found — run supabase-setup.sql to enable category management');
    categoriesManaged = false;
    rows = DEFAULT_CATEGORIES.map((c, i) => ({ ...c, id: `default-${i}`, position: i }));
  }

  // Seed defaults for new users, and adopt any category already used by an entry
  // (legacy data, or categories created in another tab) so every entry has a home.
  const known = new Set(rows.map(c => c.name));
  const missing = [];
  if (rows.length === 0) DEFAULT_CATEGORIES.forEach(c => { missing.push({ ...c }); known.add(c.name); });
  for (const e of entries) {
    if (e.category && !known.has(e.category)) { missing.push({ name: e.category, color: FALLBACK_COLOR }); known.add(e.category); }
  }
  if (missing.length) {
    const base = rows.length;
    missing.forEach((c, i) => { c.position = base + i; });
    if (categoriesManaged) {
      await db.insertCategories(missing);
      rows = await db.fetchCategories() || [];
    } else {
      rows = rows.concat(missing.map(c => ({ ...c, id: `local-${c.name}` })));
    }
  }
  categories = rows;
  renderCategoryOptions();
}

// Ensures the given names exist as categories (used by import)
async function ensureCategories(names) {
  const missing = [...new Set(names)].filter(n => n && !categories.some(c => c.name === n));
  if (!missing.length) return;
  const rows = missing.map((name, i) => ({ name, color: CATEGORY_PALETTE[(categories.length + i) % CATEGORY_PALETTE.length], position: categories.length + i }));
  if (categoriesManaged) {
    await db.insertCategories(rows);
    categories = await db.fetchCategories() || [];
  } else {
    categories = categories.concat(rows.map(c => ({ ...c, id: `local-${c.name}` })));
  }
  renderCategoryOptions();
}

function validateCategoryName(name, ignoreId = null) {
  if (!name) return 'Category name is required';
  if (name.length > CATEGORY_MAX_LENGTH) return `Category names are limited to ${CATEGORY_MAX_LENGTH} characters`;
  const dup = findCategory(name);
  if (dup && dup.id !== ignoreId) return `"${dup.name}" already exists`;
  return null;
}

function requireManagedCategories() {
  if (categoriesManaged) return true;
  showToast('Run supabase-setup.sql in Supabase to enable category editing');
  return false;
}

function renderCategoryList() {
  const counts = countByCategory();
  const trash = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
  categoryList.innerHTML = categories.map(c => `
    <li class="category-row" data-id="${escapeHtml(c.id)}">
      <input type="color" class="color-input cat-color" value="${safeColor(c.color)}" aria-label="Color for ${escapeHtml(c.name)}">
      <input type="text" class="form-input cat-name" value="${escapeHtml(c.name)}" maxlength="${CATEGORY_MAX_LENGTH}" aria-label="Name for ${escapeHtml(c.name)}">
      <span class="cat-count" title="Entries in this category">${counts[c.name] || 0}</span>
      <button type="button" class="btn btn-sm btn-primary cat-save" hidden>Save</button>
      <button type="button" class="card-action-btn delete cat-delete" title="Delete category" aria-label="Delete ${escapeHtml(c.name)}" ${categories.length <= 1 ? 'disabled' : ''}>${trash}</button>
    </li>`).join('');
  $('#new-category-color').value = nextPaletteColor();
}

function openCategoryModal() {
  renderCategoryList();
  openOverlay(categoryModal);
}

function categoryRowDirty(row) {
  const cat = categories.find(c => c.id === row.dataset.id);
  if (!cat) return false;
  return row.querySelector('.cat-name').value.trim() !== cat.name || row.querySelector('.cat-color').value.toLowerCase() !== safeColor(cat.color).toLowerCase();
}

async function saveCategoryRow(row) {
  if (!requireManagedCategories()) return;
  const cat = categories.find(c => c.id === row.dataset.id);
  if (!cat || !categoryRowDirty(row)) return;
  const name = row.querySelector('.cat-name').value.trim();
  const color = row.querySelector('.cat-color').value;
  const error = validateCategoryName(name, cat.id);
  if (error) { showToast(error); return; }
  const btn = row.querySelector('.cat-save'); btn.disabled = true;
  try {
    const updated = await db.renameCategory(cat.id, name, color);
    const oldName = cat.name;
    Object.assign(cat, updated || { name, color });
    if (oldName !== cat.name) {
      entries.forEach(e => { if (e.category === oldName) e.category = cat.name; });
      drafts.forEach(d => { if (d.category === oldName) d.category = cat.name; });
    }
    const wasFiltered = filterCategory.value === oldName;
    renderCategoryOptions();
    if (wasFiltered) filterCategory.value = cat.name;
    renderCategoryList();
    renderEntries();
    showToast(oldName !== cat.name ? `Renamed to "${cat.name}"` : 'Category updated');
  } catch (err) { console.error(err); showToast('Error updating category — check console'); btn.disabled = false; }
}

async function addCategory(e) {
  e.preventDefault();
  if (!requireManagedCategories()) return;
  const input = $('#new-category-name');
  const name = input.value.trim();
  const error = validateCategoryName(name);
  if (error) { showToast(error); return; }
  const btn = $('#btn-category-add'); btn.disabled = true;
  try {
    const position = categories.reduce((m, c) => Math.max(m, c.position ?? 0), -1) + 1;
    const rows = await db.insertCategories([{ name, color: safeColor($('#new-category-color').value), position }]);
    if (rows?.length) categories.push(rows[0]);
    else categories = await db.fetchCategories() || [];
    input.value = '';
    renderCategoryOptions();
    renderCategoryList();
    renderEntries();
    showToast(`Added "${name}"`);
    input.focus();
  } catch (err) { console.error(err); showToast('Error adding category — check console'); }
  finally { btn.disabled = false; }
}

function confirmCategoryDelete(id) {
  if (!requireManagedCategories()) return;
  const cat = categories.find(c => c.id === id);
  if (!cat) return;
  if (categories.length <= 1) { showToast('You need at least one category'); return; }
  categoryDeleteTarget = cat;
  const count = countByCategory()[cat.name] || 0;
  const others = categories.filter(c => c.id !== cat.id);
  $('#category-delete-message').textContent = count
    ? `"${cat.name}" contains ${count} entr${count === 1 ? 'y' : 'ies'}. They will be moved, not deleted.`
    : `Delete the "${cat.name}" category?`;
  $('#category-move-group').style.display = count ? 'block' : 'none';
  const moveTo = $('#category-move-to');
  moveTo.innerHTML = others.map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
  moveTo.value = others.some(c => c.name === 'Other') ? 'Other' : others[0].name;
  openOverlay(categoryDeleteModal);
}

async function executeCategoryDelete() {
  const cat = categoryDeleteTarget;
  if (!cat) return;
  const count = countByCategory()[cat.name] || 0;
  const moveTo = count ? $('#category-move-to').value : null;
  const btn = $('#btn-category-delete-confirm'); btn.disabled = true;
  try {
    await db.deleteCategory(cat.id, moveTo);
    categories = categories.filter(c => c.id !== cat.id);
    if (moveTo) entries.forEach(e => { if (e.category === cat.name) e.category = moveTo; });
    const fallback = moveTo || categories[0].name;
    drafts.forEach(d => { if (d.category === cat.name) d.category = fallback; });
    categoryDeleteTarget = null;
    closeOverlay(categoryDeleteModal);
    renderCategoryOptions();
    renderCategoryList();
    renderEntries();
    showToast(moveTo ? `Deleted "${cat.name}" — ${count} moved to ${moveTo}` : `Deleted "${cat.name}"`);
  } catch (err) { console.error(err); showToast('Error deleting category — check console'); }
  finally { btn.disabled = false; }
}

// ---- Render ----
function countByCategory() {
  const counts = {};
  for (const e of entries) counts[e.category] = (counts[e.category] || 0) + 1;
  return counts;
}

function getFiltered() {
  let list = entries;
  if (starFilterActive) list = list.filter(e => e.starred);
  const q = searchInput.value.trim().toLowerCase();
  if (q) list = list.filter(e => (e.title||'').toLowerCase().includes(q) || (e.content||'').toLowerCase().includes(q) || (e.source||'').toLowerCase().includes(q) || (e.tags||[]).some(t => t.toLowerCase().includes(q)));
  const cat = filterCategory.value;
  if (cat !== 'all') list = list.filter(e => e.category === cat);
  if (list === entries) list = [...entries];

  const byNewest = (a, b) => timestamp(b) - timestamp(a);
  switch (sortBy.value) {
    case 'newest': list.sort(byNewest); break;
    case 'oldest': list.sort((a, b) => byNewest(b, a)); break;
    case 'alpha':  list.sort((a, b) => (a.title||'').localeCompare(b.title||'')); break;
    case 'category': list.sort((a, b) => (a.category||'').localeCompare(b.category||'') || byNewest(a, b)); break;
    case 'random': list.sort((a, b) => (randomRank.get(a.id) ?? Infinity) - (randomRank.get(b.id) ?? Infinity)); break;
  }
  return list;
}

const timestamp = (e) => Date.parse(e.created_at) || 0;
const dateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
function formatDate(iso) { if (!iso) return ''; return dateFormat.format(new Date(iso)); }
function escapeHtml(str) { if (str === null || str === undefined) return ''; return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

function renderStats(filteredCount) {
  const counts = countByCategory();
  const starredCount = entries.filter(e => e.starred).length;
  statsBar.innerHTML = `
    <span class="stat-pill">${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}</span>
    ${categories.filter(c => counts[c.name]).map(c => `<span class="stat-pill">${escapeHtml(c.name)}: ${counts[c.name]}</span>`).join('')}
    ${starredCount > 0 ? `<span class="stat-pill">★ ${starredCount}</span>` : ''}
    ${filteredCount !== entries.length ? `<span class="stat-pill">Showing: ${filteredCount}</span>` : ''}
  `;
}

function renderSelection() {
  selectionControls.style.display = selectedIds.size > 0 ? 'flex' : 'none';
  selectionCount.textContent = `${selectedIds.size} selected`;
}

const ICONS = {
  star: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
  edit: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  copy: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
  trash: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
};

function cardHtml(e, i, animate) {
  const id = escapeHtml(e.id);
  const selected = selectedIds.has(e.id);
  return `
    <div class="entry-card ${selected?'selected':''} ${animate?'animate-in':''}" data-id="${id}"${animate?` style="animation-delay:${Math.min(i*30,300)}ms"`:''}>
      <div class="card-top">
        <input type="checkbox" class="card-checkbox" ${selected?'checked':''} data-id="${id}" title="Select" aria-label="Select entry">
        <div class="card-category-wrap"><span class="card-category" style="--cat:${categoryColor(e.category)}">${escapeHtml(e.category)}</span></div>
        <div class="card-actions">
          <button class="card-action-btn star-btn ${e.starred?'starred':''}" title="${e.starred?'Unstar':'Star'}" aria-label="${e.starred?'Unstar':'Star'}">${ICONS.star}</button>
          <button class="card-action-btn edit" title="Edit" aria-label="Edit">${ICONS.edit}</button>
          <button class="card-action-btn copy-single" title="Copy for Claude" aria-label="Copy for Claude">${ICONS.copy}</button>
          <button class="card-action-btn delete" title="Delete" aria-label="Delete">${ICONS.trash}</button>
        </div>
      </div>
      <h3 class="card-title">${escapeHtml(e.title)}</h3>
      <p class="card-content">${escapeHtml(e.content)}</p>
      ${(e.tags&&e.tags.length)?`<div class="card-tags">${e.tags.map(t=>`<span class="card-tag">${escapeHtml(t)}</span>`).join('')}</div>`:''}
      <div class="card-meta"><span class="card-source">${e.source?escapeHtml(e.source):''}</span><span class="card-date">${formatDate(e.created_at)}</span></div>
    </div>`;
}

// animate: play the card entrance animation (only when the visible set changes,
// not on in-place updates like starring or selecting)
function renderEntries({ animate = false } = {}) {
  const filtered = getFiltered();
  btnReshuffle.style.display = sortBy.value === 'random' ? 'flex' : 'none';
  renderStats(filtered.length);
  renderSelection();

  if (entries.length === 0) { grid.style.display = 'none'; emptyState.style.display = 'block'; return; }
  emptyState.style.display = 'none'; grid.style.display = 'grid';
  if (filtered.length === 0) { grid.innerHTML = `<div class="no-results"><p class="no-results-title">No matching entries</p><p>Try adjusting your search or filters.</p></div>`; return; }
  grid.innerHTML = filtered.map((e, i) => cardHtml(e, i, animate)).join('');
}

function toggleSelected(id, card) {
  if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id);
  card.classList.toggle('selected', selectedIds.has(id));
  renderSelection();
}

// ---- Entry modal & drafts ----
function readForm() {
  return {
    title: $('#entry-title').value,
    category: entryCategory.value,
    source: $('#entry-source').value,
    content: $('#entry-content').value,
    tags: $('#entry-tags').value,
    starred: $('#entry-starred').checked,
  };
}

function fillForm(f) {
  $('#entry-title').value = f.title;
  entryCategory.value = f.category;
  if (!entryCategory.value && categories.length) entryCategory.value = categories[0].name;
  $('#entry-source').value = f.source;
  $('#entry-content').value = f.content;
  $('#entry-tags').value = f.tags;
  $('#entry-starred').checked = f.starred;
}

function formFromEntry(entry) {
  return {
    title: entry?.title || '',
    category: entry?.category || categories[0]?.name || '',
    source: entry?.source || '',
    content: entry?.content || '',
    tags: (entry?.tags || []).join(', '),
    starred: entry?.starred || false,
  };
}

function sameForm(a, b) { return Object.keys(a).every(k => a[k] === b[k]); }
function draftKey() { return editingId || 'new'; }
function updateDraftIndicator() { btnNewEntry.classList.toggle('has-draft', drafts.has('new')); btnNewEntry.title = drafts.has('new') ? 'Continue your unsaved entry' : ''; }

function openModal(entry = null) {
  editingId = entry ? entry.id : null;
  $('#modal-title').textContent = entry ? 'Edit Entry' : 'New Entry';
  modalBaseline = formFromEntry(entry);
  const draft = drafts.get(draftKey());
  fillForm(draft || modalBaseline);
  openOverlay(entryModal);
  if (draft) showToast('Unsaved draft restored');
  setTimeout(() => $(draft ? '#entry-content' : '#entry-title').focus(), 50);
}

// keepDraft: stash unsaved changes so reopening the same entry restores them
function closeModal({ keepDraft = true } = {}) {
  if (!isOpen(entryModal)) return;
  const key = draftKey();
  const form = readForm();
  if (keepDraft && modalBaseline && !sameForm(form, modalBaseline)) drafts.set(key, form);
  else drafts.delete(key);
  closeOverlay(entryModal);
  editingId = null; modalBaseline = null;
  updateDraftIndicator();
}

async function saveEntry() {
  if (saving) return;
  const title = $('#entry-title').value.trim();
  const category = entryCategory.value;
  const source = $('#entry-source').value.trim();
  const content = $('#entry-content').value.trim();
  const tags = [...new Set($('#entry-tags').value.split(',').map(t => t.trim()).filter(Boolean))];
  const starred = $('#entry-starred').checked;

  if (!title) { showToast('Title is required'); return; }
  if (!content) { showToast('Content is required'); return; }
  if (!category) { showToast('Choose a category'); return; }

  const data = { title, category, source, content, tags, starred };
  const saveBtn = $('#btn-modal-save');
  saving = true; saveBtn.disabled = true;
  try {
    if (editingId) {
      const updated = await db.update(editingId, data);
      const idx = entries.findIndex(e => e.id === editingId);
      if (idx >= 0) entries[idx] = { ...entries[idx], ...data, ...(updated || {}) };
      showToast('Entry updated');
    } else {
      const created = await db.insert(data);
      if (created) { entries.unshift(created); randomRank.set(created.id, -1); }
      showToast('Entry added');
    }
    closeModal({ keepDraft: false });
    renderEntries();
  } catch (err) { console.error(err); showToast('Error saving — check console'); }
  finally { saving = false; saveBtn.disabled = false; }
}

async function toggleStar(id) {
  const entry = entries.find(e => e.id === id);
  if (!entry) return;
  const newVal = !entry.starred;
  // Optimistic: flip immediately, roll back if the request fails
  entry.starred = newVal; renderEntries();
  try {
    await db.update(id, { starred: newVal });
    showToast(newVal ? 'Entry starred' : 'Star removed');
  } catch (err) { console.error(err); entry.starred = !newVal; renderEntries(); showToast('Error updating star — check console'); }
}

function confirmDelete(id) {
  deleteTarget = id;
  $('#delete-message').textContent = id === 'selected' ? `Delete ${selectedIds.size} selected entries? This cannot be undone.` : 'Are you sure you want to delete this entry? This cannot be undone.';
  openOverlay(deleteModal);
}

async function executeDelete() {
  const btn = $('#btn-delete-confirm'); btn.disabled = true;
  try {
    if (deleteTarget === 'selected') {
      const ids = [...selectedIds];
      await db.removeMany(ids);
      entries = entries.filter(e => !selectedIds.has(e.id));
      ids.forEach(id => drafts.delete(id));
      selectedIds.clear();
      showToast(`${ids.length} entr${ids.length === 1 ? 'y' : 'ies'} deleted`);
    } else {
      await db.remove(deleteTarget);
      entries = entries.filter(e => e.id !== deleteTarget);
      selectedIds.delete(deleteTarget);
      drafts.delete(deleteTarget);
      showToast('Entry deleted');
    }
    closeOverlay(deleteModal); deleteTarget = null; renderEntries();
  } catch (err) { console.error(err); showToast('Error deleting — check console'); }
  finally { btn.disabled = false; }
}

// ---- Copy for Claude ----
function formatForClaude(entryList) {
  return entryList.map(e => {
    let block = `## ${e.title}\n**Category:** ${e.category}\n`;
    if (e.source) block += `**Source:** ${e.source}\n`;
    if (e.tags?.length) block += `**Tags:** ${e.tags.join(', ')}\n`;
    if (e.starred) block += `**Starred:** Yes\n`;
    block += `\n${e.content}`;
    return block;
  }).join('\n\n---\n\n');
}
function copyForClaude(entryList) {
  const text = `<context>\nThe following are entries from my Commonplace Book — a curated collection of quotes, ideas, references, reflections, and frameworks.\n\n${formatForClaude(entryList)}\n</context>`;
  navigator.clipboard.writeText(text).then(() => showToast(`Copied ${entryList.length} entr${entryList.length===1?'y':'ies'} for Claude`)).catch(() => showToast('Copy failed — check browser permissions'));
}

// ---- Export / Import ----
function exportJSON(entryList, filename = 'commonplace-book-export.json') {
  const blob = new Blob([JSON.stringify(entryList, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  showToast(`Exported ${entryList.length} entries`);
}
async function importJSON(file) {
  try {
    const text = await file.text(); const data = JSON.parse(text); const arr = Array.isArray(data) ? data : [data];
    const list = arr.filter(item => item && typeof item === 'object').map(item => ({
      title: String(item.title || 'Untitled'),
      category: String(item.category || 'Ideas').trim().slice(0, CATEGORY_MAX_LENGTH) || 'Ideas',
      source: String(item.source || ''),
      content: String(item.content || ''),
      tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
      starred: !!item.starred,
    }));
    if (!list.length) { showToast('No entries found in file'); return; }
    // Match categories case-insensitively to existing ones, create the rest
    list.forEach(e => { const existing = findCategory(e.category); if (existing) e.category = existing.name; });
    await ensureCategories(list.map(e => e.category));
    const created = await db.insertMany(list) || [];
    entries = [...created.reverse(), ...entries];
    generateRandomOrder();
    renderEntries({ animate: true }); showToast(`Imported ${created.length} entries`);
  } catch (err) { console.error(err); showToast('Import failed — check file format'); }
}

// ---- Events ----
btnNewEntry.addEventListener('click', () => openModal());
$('#btn-empty-new').addEventListener('click', () => openModal());
$('#btn-modal-close').addEventListener('click', () => closeModal());
$('#btn-modal-cancel').addEventListener('click', () => closeModal({ keepDraft: false }));
$('#btn-modal-save').addEventListener('click', saveEntry);
entryModal.addEventListener('click', (e) => { if (e.target === entryModal) closeModal(); });
$('#btn-delete-cancel').addEventListener('click', () => closeOverlay(deleteModal));
$('#btn-delete-confirm').addEventListener('click', executeDelete);
deleteModal.addEventListener('click', (e) => { if (e.target === deleteModal) closeOverlay(deleteModal); });

$('#btn-categories').addEventListener('click', openCategoryModal);
$('#btn-category-close').addEventListener('click', () => closeOverlay(categoryModal));
$('#btn-category-done').addEventListener('click', () => closeOverlay(categoryModal));
categoryModal.addEventListener('click', (e) => { if (e.target === categoryModal) closeOverlay(categoryModal); });
$('#category-add-form').addEventListener('submit', addCategory);
categoryList.addEventListener('input', (e) => {
  const row = e.target.closest('.category-row');
  if (row) row.querySelector('.cat-save').hidden = !categoryRowDirty(row);
});
categoryList.addEventListener('click', (e) => {
  const row = e.target.closest('.category-row');
  if (!row) return;
  if (e.target.closest('.cat-save')) saveCategoryRow(row);
  else if (e.target.closest('.cat-delete')) confirmCategoryDelete(row.dataset.id);
});
categoryList.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('cat-name')) { e.preventDefault(); saveCategoryRow(e.target.closest('.category-row')); }
});
$('#btn-category-delete-cancel').addEventListener('click', () => { categoryDeleteTarget = null; closeOverlay(categoryDeleteModal); });
$('#btn-category-delete-confirm').addEventListener('click', executeCategoryDelete);
categoryDeleteModal.addEventListener('click', (e) => { if (e.target === categoryDeleteModal) { categoryDeleteTarget = null; closeOverlay(categoryDeleteModal); } });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (isOpen(deleteModal)) closeOverlay(deleteModal);
    else if (isOpen(categoryDeleteModal)) { categoryDeleteTarget = null; closeOverlay(categoryDeleteModal); }
    else if (isOpen(categoryModal)) closeOverlay(categoryModal);
    else if (isOpen(entryModal)) closeModal();
  }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && isOpen(entryModal)) saveEntry();
});

let searchTimer;
searchInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => renderEntries(), 120); });
filterCategory.addEventListener('change', () => renderEntries({ animate: true }));
sortBy.addEventListener('change', () => {
  // Every time Random is selected (or re-selected), generate a fresh order
  if (sortBy.value === 'random') generateRandomOrder();
  renderEntries({ animate: true });
});

btnStarFilter.addEventListener('click', () => {
  starFilterActive = !starFilterActive;
  btnStarFilter.classList.toggle('active', starFilterActive);
  btnStarFilter.setAttribute('aria-pressed', String(starFilterActive));
  renderEntries({ animate: true });
});

btnReshuffle.addEventListener('click', () => {
  generateRandomOrder();
  renderEntries({ animate: true });
});

grid.addEventListener('click', (e) => {
  const card = e.target.closest('.entry-card');
  if (!card) return;
  const id = card.dataset.id;
  if (e.target.classList.contains('card-checkbox')) { toggleSelected(id, card); return; }
  if (e.target.closest('.card-action-btn.star-btn')) { toggleStar(id); return; }
  if (e.target.closest('.card-action-btn.edit')) { const entry = entries.find(en => en.id === id); if (entry) openModal(entry); return; }
  if (e.target.closest('.card-action-btn.copy-single')) { const entry = entries.find(en => en.id === id); if (entry) copyForClaude([entry]); return; }
  if (e.target.closest('.card-action-btn.delete')) { confirmDelete(id); return; }
});

$('#btn-copy-claude').addEventListener('click', () => { const selected = entries.filter(e => selectedIds.has(e.id)); if (selected.length) copyForClaude(selected); });
$('#btn-export-selected').addEventListener('click', () => { const selected = entries.filter(e => selectedIds.has(e.id)); if (selected.length) exportJSON(selected, 'commonplace-selected.json'); });
$('#btn-delete-selected').addEventListener('click', () => { if (selectedIds.size) confirmDelete('selected'); });
$('#btn-clear-selection').addEventListener('click', () => { selectedIds.clear(); renderEntries(); });
$('#btn-export').addEventListener('click', () => exportJSON(entries));
$('#btn-import').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', (e) => { const file = e.target.files[0]; if (file) importJSON(file); e.target.value = ''; });

// ---- Init ----
const loadingHtml = loadingState.innerHTML;
async function loadData() {
  loadingState.innerHTML = loadingHtml;
  loadingState.style.display = 'block'; grid.style.display = 'none'; emptyState.style.display = 'none';
  try {
    entries = await db.fetchAll() || [];
    entries.forEach(e => { if (e.starred === undefined || e.starred === null) e.starred = false; });
    await loadCategories();
    generateRandomOrder();
    loadingState.style.display = 'none';
    renderEntries({ animate: true });
  } catch (err) {
    console.error('Failed to load entries:', err);
    loadingState.innerHTML = `<p style="color:var(--danger);font-weight:500;">Failed to load entries</p><p style="font-size:0.85rem;margin-top:8px;color:var(--text-tertiary);">${escapeHtml(err.message)}</p>`;
  }
}

async function init() {
  const restored = await auth.restoreSession();
  if (restored) { showApp(); loadData(); } else { showAuthScreen(); }
}
init();
