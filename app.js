/* ============================================
   COMMONPLACE BOOK — Application Logic v2
   Supabase Auth + locked-down RLS
   ============================================ */

const SUPABASE_URL = 'https://llmtqxtcpmrgwkfpudnw.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxsbXRxeHRjcG1yZ3drZnB1ZG53Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4NTM1NTAsImV4cCI6MjA4OTQyOTU1MH0.BSCvcNFKSnZDZCqDtHqoLkUBUYlRUQx6VY9-vydFnH8';

let accessToken = null;
let currentUser = null;

// ---- Auth ----
const auth = {
  async signUp(email, password) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, { method: 'POST', headers: { 'apikey': SUPABASE_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error?.message || data.msg || 'Signup failed');
    return data;
  },
  async signIn(email, password) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { 'apikey': SUPABASE_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error?.message || data.error_description || 'Login failed');
    return data;
  },
  async refreshToken(rt) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: { 'apikey': SUPABASE_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: rt }) });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error('Session expired — please sign in again');
    return data;
  },
  async getUser(token) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${token}` } });
    const data = await res.json();
    if (!res.ok) throw new Error('Could not fetch user');
    return data;
  },
  saveSession(data) {
    accessToken = data.access_token;
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
  async restoreSession() {
    const token = localStorage.getItem('sb_access_token');
    const refresh = localStorage.getItem('sb_refresh_token');
    const expiresAt = parseInt(localStorage.getItem('sb_expires_at') || '0');
    if (!token || !refresh) return false;
    if (Date.now() > expiresAt - 60000) {
      try { const data = await this.refreshToken(refresh); this.saveSession(data); currentUser = data.user; return true; }
      catch { this.clearSession(); return false; }
    }
    accessToken = token;
    try { currentUser = await this.getUser(token); return true; }
    catch { this.clearSession(); return false; }
  }
};

// ---- DB ----
const db = {
  async request(method, path, body = null) {
    if (!accessToken) throw new Error('Not authenticated');
    const headers = { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
    if (method === 'POST' || method === 'PATCH') headers['Prefer'] = 'return=representation';
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, opts);
    if (res.status === 401) {
      try {
        const refresh = localStorage.getItem('sb_refresh_token');
        if (refresh) { const data = await auth.refreshToken(refresh); auth.saveSession(data); headers['Authorization'] = `Bearer ${accessToken}`; const retry = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }); if (!retry.ok) throw new Error('Request failed after token refresh'); const text = await retry.text(); return text ? JSON.parse(text) : null; }
      } catch { auth.clearSession(); showAuthScreen(); throw new Error('Session expired — please sign in again'); }
    }
    if (!res.ok) { const text = await res.text(); throw new Error(`${method} ${path}: ${res.status} — ${text}`); }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  },
  async fetchAll() { return this.request('GET', 'entries?select=*&order=created_at.desc'); },
  async insert(entry) {
    const payload = { ...entry, user_id: currentUser.id };
    const rows = await this.request('POST', 'entries', payload);
    return rows?.[0] || rows;
  },
  async update(id, updates) { const rows = await this.request('PATCH', `entries?id=eq.${id}`, updates); return rows?.[0] || rows; },
  async remove(id) { return this.request('DELETE', `entries?id=eq.${id}`); }
};

// ---- State ----
let entries = [];
let selectedIds = new Set();
let editingId = null;
let deleteTarget = null;
let starFilterActive = false;

// randomOrder stores a pre-shuffled copy of entry IDs; regenerated on demand
let randomOrder = [];

const $ = (sel) => document.querySelector(sel);
const authScreen = $('#auth-screen');
const appShell = $('#app-shell');
const grid = $('#entries-grid');
const emptyState = $('#empty-state');
const loadingState = $('#loading-state');
const entryModal = $('#entry-modal');
const deleteModal = $('#delete-modal');
const searchInput = $('#search-input');
const filterCategory = $('#filter-category');
const sortBy = $('#sort-by');
const selectionControls = $('#selection-controls');
const selectionCount = $('#selection-count');
const statsBar = $('#stats-bar');
const toast = $('#toast');
const btnStarFilter = $('#btn-star-filter');
const btnReshuffle = $('#btn-reshuffle');

let toastTimer;
function showToast(msg) { toast.textContent = msg; toast.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('visible'), 2600); }

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
  randomOrder = shuffleArray(entries.map(e => e.id));
}

// ---- Auth UI ----
function showAuthScreen() { authScreen.style.display = 'flex'; appShell.style.display = 'none'; }
function showApp() { authScreen.style.display = 'none'; appShell.style.display = 'block'; if (currentUser) $('#user-email').textContent = currentUser.email || ''; }
function showAuthError(msg) { const el = $('#auth-error'); el.textContent = msg; el.style.display = 'block'; $('#auth-success').style.display = 'none'; }
function showAuthSuccess(msg) { const el = $('#auth-success'); el.textContent = msg; el.style.display = 'block'; $('#auth-error').style.display = 'none'; }
function clearAuthMessages() { $('#auth-error').style.display = 'none'; $('#auth-success').style.display = 'none'; }

$('#link-to-signup').addEventListener('click', (e) => { e.preventDefault(); clearAuthMessages(); $('#auth-login').style.display = 'none'; $('#auth-signup').style.display = 'block'; });
$('#link-to-login').addEventListener('click', (e) => { e.preventDefault(); clearAuthMessages(); $('#auth-signup').style.display = 'none'; $('#auth-login').style.display = 'block'; });

$('#btn-signup').addEventListener('click', async () => {
  const email = $('#signup-email').value.trim(); const password = $('#signup-password').value; clearAuthMessages();
  if (!email || !password) { showAuthError('Email and password are required'); return; }
  if (password.length < 6) { showAuthError('Password must be at least 6 characters'); return; }
  $('#btn-signup').disabled = true; $('#btn-signup').textContent = 'Creating…';
  try { const data = await auth.signUp(email, password); if (data.access_token) { auth.saveSession(data); currentUser = data.user; showApp(); loadEntries(); } else { showAuthSuccess('Account created! Check your email to confirm, then sign in.'); $('#auth-signup').style.display = 'none'; $('#auth-login').style.display = 'block'; } }
  catch (err) { showAuthError(err.message); }
  finally { $('#btn-signup').disabled = false; $('#btn-signup').textContent = 'Create Account'; }
});

$('#btn-login').addEventListener('click', async () => {
  const email = $('#login-email').value.trim(); const password = $('#login-password').value; clearAuthMessages();
  if (!email || !password) { showAuthError('Email and password are required'); return; }
  $('#btn-login').disabled = true; $('#btn-login').textContent = 'Signing in…';
  try { const data = await auth.signIn(email, password); auth.saveSession(data); currentUser = data.user; showApp(); loadEntries(); }
  catch (err) { showAuthError(err.message); }
  finally { $('#btn-login').disabled = false; $('#btn-login').textContent = 'Sign In'; }
});

$('#login-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-login').click(); });
$('#signup-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-signup').click(); });
$('#btn-logout').addEventListener('click', () => { auth.clearSession(); entries = []; selectedIds.clear(); showAuthScreen(); showToast('Signed out'); });

// ---- Render ----
function getFiltered() {
  let list = [...entries];
  if (starFilterActive) list = list.filter(e => e.starred);
  const q = searchInput.value.trim().toLowerCase();
  if (q) list = list.filter(e => (e.title||'').toLowerCase().includes(q) || (e.content||'').toLowerCase().includes(q) || (e.source||'').toLowerCase().includes(q) || (e.tags||[]).some(t => t.toLowerCase().includes(q)));
  const cat = filterCategory.value;
  if (cat !== 'all') list = list.filter(e => e.category === cat);

  const sort = sortBy.value;
  switch (sort) {
    case 'newest': list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); break;
    case 'oldest': list.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)); break;
    case 'alpha':  list.sort((a, b) => (a.title||'').localeCompare(b.title||'')); break;
    case 'category': list.sort((a, b) => (a.category||'').localeCompare(b.category||'') || new Date(b.created_at) - new Date(a.created_at)); break;
    case 'random':
      // Sort by pre-computed random order
      const orderMap = {};
      randomOrder.forEach((id, idx) => { orderMap[id] = idx; });
      list.sort((a, b) => (orderMap[a.id] ?? 9999) - (orderMap[b.id] ?? 9999));
      break;
  }
  return list;
}

function formatDate(iso) { if (!iso) return ''; return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
function escapeHtml(str) { if (!str) return ''; return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function renderEntries() {
  const filtered = getFiltered();
  btnReshuffle.style.display = sortBy.value === 'random' ? 'flex' : 'none';

  const catCounts = {};
  entries.forEach(e => { catCounts[e.category] = (catCounts[e.category]||0) + 1; });
  const starredCount = entries.filter(e => e.starred).length;
  statsBar.innerHTML = `
    <span class="stat-pill">${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}</span>
    ${Object.entries(catCounts).map(([c,n]) => `<span class="stat-pill">${c}: ${n}</span>`).join('')}
    ${starredCount > 0 ? `<span class="stat-pill">★ ${starredCount}</span>` : ''}
    ${filtered.length !== entries.length ? `<span class="stat-pill">Showing: ${filtered.length}</span>` : ''}
  `;

  selectionControls.style.display = selectedIds.size > 0 ? 'flex' : 'none';
  selectionCount.textContent = `${selectedIds.size} selected`;

  if (entries.length === 0) { grid.style.display = 'none'; emptyState.style.display = 'block'; return; }
  emptyState.style.display = 'none'; grid.style.display = 'grid';
  if (filtered.length === 0) { grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:48px 16px;color:var(--text-tertiary);"><p style="font-size:1.1rem;margin-bottom:4px;">No matching entries</p><p style="font-size:0.85rem;">Try adjusting your search or filters.</p></div>`; return; }

  const starSvg = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;

  grid.innerHTML = filtered.map((e, i) => `
    <div class="entry-card ${selectedIds.has(e.id)?'selected':''}" data-id="${e.id}" style="animation-delay:${Math.min(i*30,300)}ms">
      <div class="card-top">
        <input type="checkbox" class="card-checkbox" ${selectedIds.has(e.id)?'checked':''} data-id="${e.id}" title="Select">
        <div style="flex:1;min-width:0;"><span class="card-category" data-cat="${escapeHtml(e.category)}">${escapeHtml(e.category)}</span></div>
        <div class="card-actions">
          <button class="card-action-btn star-btn ${e.starred?'starred':''}" data-id="${e.id}" title="${e.starred?'Unstar':'Star'}">${starSvg}</button>
          <button class="card-action-btn edit" data-id="${e.id}" title="Edit"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
          <button class="card-action-btn copy-single" data-id="${e.id}" title="Copy for Claude"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
          <button class="card-action-btn delete" data-id="${e.id}" title="Delete"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
        </div>
      </div>
      <h3 class="card-title">${escapeHtml(e.title)}</h3>
      <p class="card-content">${escapeHtml(e.content)}</p>
      ${(e.tags&&e.tags.length)?`<div class="card-tags">${e.tags.map(t=>`<span class="card-tag">${escapeHtml(t)}</span>`).join('')}</div>`:''}
      <div class="card-meta"><span class="card-source">${e.source?escapeHtml(e.source):''}</span><span>${formatDate(e.created_at)}</span></div>
    </div>
  `).join('');
}

// ---- CRUD ----
function openModal(entry = null) {
  editingId = entry ? entry.id : null;
  $('#modal-title').textContent = entry ? 'Edit Entry' : 'New Entry';
  $('#entry-title').value = entry?.title || '';
  $('#entry-category').value = entry?.category || 'Quotes';
  $('#entry-source').value = entry?.source || '';
  $('#entry-content').value = entry?.content || '';
  $('#entry-tags').value = (entry?.tags || []).join(', ');
  $('#entry-starred').checked = entry?.starred || false;
  entryModal.style.display = 'flex';
  setTimeout(() => $('#entry-title').focus(), 50);
}

function closeModal() { entryModal.style.display = 'none'; editingId = null; }

async function saveEntry() {
  const title = $('#entry-title').value.trim();
  const category = $('#entry-category').value;
  const source = $('#entry-source').value.trim();
  const content = $('#entry-content').value.trim();
  const tags = $('#entry-tags').value.split(',').map(t => t.trim()).filter(Boolean);
  const starred = $('#entry-starred').checked;

  if (!title) { showToast('Title is required'); return; }
  if (!content) { showToast('Content is required'); return; }

  const data = { title, category, source, content, tags, starred };

  try {
    if (editingId) {
      await db.update(editingId, data);
      const idx = entries.findIndex(e => e.id === editingId);
      if (idx >= 0) entries[idx] = { ...entries[idx], ...data };
      showToast('Entry updated');
    } else {
      const created = await db.insert(data);
      if (created) entries.unshift(created);
      showToast('Entry added');
    }
    closeModal();
    renderEntries();
  } catch (err) { console.error(err); showToast('Error saving — check console'); }
}

async function toggleStar(id) {
  const entry = entries.find(e => e.id === id);
  if (!entry) return;
  const newVal = !entry.starred;
  try {
    await db.update(id, { starred: newVal });
    entry.starred = newVal;
    renderEntries();
    showToast(newVal ? 'Entry starred' : 'Star removed');
  } catch (err) { console.error(err); showToast('Error updating star — check console'); }
}

function confirmDelete(id) {
  deleteTarget = id;
  $('#delete-message').textContent = id === 'selected' ? `Delete ${selectedIds.size} selected entries? This cannot be undone.` : 'Are you sure you want to delete this entry? This cannot be undone.';
  deleteModal.style.display = 'flex';
}

async function executeDelete() {
  try {
    if (deleteTarget === 'selected') {
      for (const id of selectedIds) await db.remove(id);
      entries = entries.filter(e => !selectedIds.has(e.id));
      const count = selectedIds.size; selectedIds.clear();
      showToast(`${count} entries deleted`);
    } else {
      await db.remove(deleteTarget);
      entries = entries.filter(e => e.id !== deleteTarget);
      selectedIds.delete(deleteTarget);
      showToast('Entry deleted');
    }
    deleteModal.style.display = 'none'; deleteTarget = null; renderEntries();
  } catch (err) { console.error(err); showToast('Error deleting — check console'); }
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
    const text = await file.text(); const data = JSON.parse(text); const arr = Array.isArray(data) ? data : [data]; let count = 0;
    for (const item of arr) {
      const entry = { title: item.title||'Untitled', category: item.category||'Ideas', source: item.source||'', content: item.content||'', tags: item.tags||[], starred: item.starred||false };
      const created = await db.insert(entry);
      if (created) { entries.unshift(created); count++; }
    }
    renderEntries(); showToast(`Imported ${count} entries`);
  } catch (err) { console.error(err); showToast('Import failed — check file format'); }
}

// ---- Events ----
$('#btn-new-entry').addEventListener('click', () => openModal());
$('#btn-empty-new').addEventListener('click', () => openModal());
$('#btn-modal-close').addEventListener('click', closeModal);
$('#btn-modal-cancel').addEventListener('click', closeModal);
$('#btn-modal-save').addEventListener('click', saveEntry);
entryModal.addEventListener('click', (e) => { if (e.target === entryModal) closeModal(); });
$('#btn-delete-cancel').addEventListener('click', () => { deleteModal.style.display = 'none'; });
$('#btn-delete-confirm').addEventListener('click', executeDelete);
deleteModal.addEventListener('click', (e) => { if (e.target === deleteModal) deleteModal.style.display = 'none'; });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (deleteModal.style.display === 'flex') deleteModal.style.display = 'none'; else if (entryModal.style.display === 'flex') closeModal(); }
  if (e.key === 'Enter' && e.ctrlKey && entryModal.style.display === 'flex') saveEntry();
});

searchInput.addEventListener('input', renderEntries);
filterCategory.addEventListener('change', renderEntries);
sortBy.addEventListener('change', () => {
  // Every time Random is selected (or re-selected), generate a fresh order
  if (sortBy.value === 'random') generateRandomOrder();
  renderEntries();
});

btnStarFilter.addEventListener('click', () => {
  starFilterActive = !starFilterActive;
  btnStarFilter.classList.toggle('active', starFilterActive);
  renderEntries();
});

btnReshuffle.addEventListener('click', () => {
  generateRandomOrder();
  renderEntries();
});

grid.addEventListener('click', (e) => {
  const card = e.target.closest('.entry-card');
  if (!card) return;
  const id = card.dataset.id;
  if (e.target.classList.contains('card-checkbox')) { if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id); renderEntries(); return; }
  if (e.target.closest('.card-action-btn.star-btn')) { toggleStar(id); return; }
  if (e.target.closest('.card-action-btn.edit')) { const entry = entries.find(en => en.id == id); if (entry) openModal(entry); return; }
  if (e.target.closest('.card-action-btn.copy-single')) { const entry = entries.find(en => en.id == id); if (entry) copyForClaude([entry]); return; }
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
async function loadEntries() {
  loadingState.style.display = 'block'; grid.style.display = 'none'; emptyState.style.display = 'none';
  try {
    entries = await db.fetchAll() || [];
    entries.forEach(e => { if (e.starred === undefined || e.starred === null) e.starred = false; });
    generateRandomOrder();
    loadingState.style.display = 'none';
    renderEntries();
  } catch (err) {
    console.error('Failed to load entries:', err);
    loadingState.innerHTML = `<p style="color:var(--danger);font-weight:500;">Failed to load entries</p><p style="font-size:0.85rem;margin-top:8px;color:var(--text-tertiary);">${escapeHtml(err.message)}</p>`;
  }
}

async function init() {
  const restored = await auth.restoreSession();
  if (restored) { showApp(); loadEntries(); } else { showAuthScreen(); }
}
init();
