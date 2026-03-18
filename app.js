/* ============================================
   COMMONPLACE BOOK — Application Logic
   Supabase-backed CRUD with local state
   ============================================ */

// ---- Supabase Config ----
const SUPABASE_URL = 'https://llmtqxtcpmrgwkfpudnw.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxsbXRxeHRjcG1yZ3drZnB1ZG53Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4NTM1NTAsImV4cCI6MjA4OTQyOTU1MH0.BSCvcNFKSnZDZCqDtHqoLkUBUYlRUQx6VY9-vydFnH8';

const supabase = {
  async request(method, path, body = null) {
    const opts = {
      method,
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': method === 'POST' ? 'return=representation' : (method === 'PATCH' ? 'return=representation' : ''),
      },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, opts);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Supabase ${method} ${path}: ${res.status} - ${text}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  },
  async fetchAll() {
    return this.request('GET', 'entries?select=*&order=created_at.desc');
  },
  async insert(entry) {
    const rows = await this.request('POST', 'entries', entry);
    return rows?.[0] || rows;
  },
  async update(id, updates) {
    const rows = await this.request('PATCH', `entries?id=eq.${id}`, updates);
    return rows?.[0] || rows;
  },
  async remove(id) {
    return this.request('DELETE', `entries?id=eq.${id}`);
  }
};

// ---- App State ----
let entries = [];
let selectedIds = new Set();
let editingId = null;
let deleteTarget = null; // single id or 'selected'

// ---- DOM refs ----
const $ = (sel) => document.querySelector(sel);
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

// ---- Toast ----
let toastTimer;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2600);
}

// ---- Render ----
function getFiltered() {
  let list = [...entries];
  // Search
  const q = searchInput.value.trim().toLowerCase();
  if (q) {
    list = list.filter(e =>
      (e.title || '').toLowerCase().includes(q) ||
      (e.content || '').toLowerCase().includes(q) ||
      (e.source || '').toLowerCase().includes(q) ||
      (e.tags || []).some(t => t.toLowerCase().includes(q))
    );
  }
  // Category filter
  const cat = filterCategory.value;
  if (cat !== 'all') {
    list = list.filter(e => e.category === cat);
  }
  // Sort
  const sort = sortBy.value;
  switch (sort) {
    case 'newest':
      list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      break;
    case 'oldest':
      list.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      break;
    case 'alpha':
      list.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
      break;
    case 'category':
      list.sort((a, b) => (a.category || '').localeCompare(b.category || '') || new Date(b.created_at) - new Date(a.created_at));
      break;
  }
  return list;
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderEntries() {
  const filtered = getFiltered();

  // Stats
  const catCounts = {};
  entries.forEach(e => { catCounts[e.category] = (catCounts[e.category] || 0) + 1; });
  statsBar.innerHTML = `
    <span class="stat-pill" id="stat-total">${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}</span>
    ${Object.entries(catCounts).map(([c, n]) => `<span class="stat-pill">${c}: ${n}</span>`).join('')}
    ${filtered.length !== entries.length ? `<span class="stat-pill">Showing: ${filtered.length}</span>` : ''}
  `;

  // Selection bar
  if (selectedIds.size > 0) {
    selectionControls.style.display = 'flex';
    selectionCount.textContent = `${selectedIds.size} selected`;
  } else {
    selectionControls.style.display = 'none';
  }

  // Cards
  if (entries.length === 0) {
    grid.style.display = 'none';
    emptyState.style.display = 'block';
    return;
  }
  emptyState.style.display = 'none';
  grid.style.display = 'grid';

  if (filtered.length === 0) {
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:48px 16px;color:var(--text-tertiary);">
      <p style="font-size:1.1rem;margin-bottom:4px;">No matching entries</p>
      <p style="font-size:0.85rem;">Try adjusting your search or filters.</p>
    </div>`;
    return;
  }

  grid.innerHTML = filtered.map((e, i) => `
    <div class="entry-card ${selectedIds.has(e.id) ? 'selected' : ''}" data-id="${e.id}" style="animation-delay:${Math.min(i * 30, 300)}ms">
      <div class="card-top">
        <input type="checkbox" class="card-checkbox" ${selectedIds.has(e.id) ? 'checked' : ''} data-id="${e.id}" title="Select entry">
        <div style="flex:1;min-width:0;">
          <span class="card-category" data-cat="${escapeHtml(e.category)}">${escapeHtml(e.category)}</span>
        </div>
        <div class="card-actions">
          <button class="card-action-btn edit" data-id="${e.id}" title="Edit">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="card-action-btn copy-single" data-id="${e.id}" title="Copy for Claude">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          </button>
          <button class="card-action-btn delete" data-id="${e.id}" title="Delete">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>
      <h3 class="card-title">${escapeHtml(e.title)}</h3>
      <p class="card-content">${escapeHtml(e.content)}</p>
      ${(e.tags && e.tags.length) ? `<div class="card-tags">${e.tags.map(t => `<span class="card-tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
      <div class="card-meta">
        <span class="card-source">${e.source ? escapeHtml(e.source) : ''}</span>
        <span>${formatDate(e.created_at)}</span>
      </div>
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
  entryModal.style.display = 'flex';
  setTimeout(() => $('#entry-title').focus(), 50);
}

function closeModal() {
  entryModal.style.display = 'none';
  editingId = null;
}

async function saveEntry() {
  const title = $('#entry-title').value.trim();
  const category = $('#entry-category').value;
  const source = $('#entry-source').value.trim();
  const content = $('#entry-content').value.trim();
  const tags = $('#entry-tags').value.split(',').map(t => t.trim()).filter(Boolean);

  if (!title) { showToast('Title is required'); return; }
  if (!content) { showToast('Content is required'); return; }

  const data = { title, category, source, content, tags };

  try {
    if (editingId) {
      const updated = await supabase.update(editingId, data);
      const idx = entries.findIndex(e => e.id === editingId);
      if (idx >= 0) entries[idx] = { ...entries[idx], ...data };
      showToast('Entry updated');
    } else {
      const created = await supabase.insert(data);
      if (created) entries.unshift(created);
      showToast('Entry added');
    }
    closeModal();
    renderEntries();
  } catch (err) {
    console.error(err);
    showToast('Error saving — check console');
  }
}

function confirmDelete(id) {
  deleteTarget = id;
  if (id === 'selected') {
    $('#delete-message').textContent = `Delete ${selectedIds.size} selected entries? This cannot be undone.`;
  } else {
    $('#delete-message').textContent = 'Are you sure you want to delete this entry? This cannot be undone.';
  }
  deleteModal.style.display = 'flex';
}

async function executeDelete() {
  try {
    if (deleteTarget === 'selected') {
      for (const id of selectedIds) {
        await supabase.remove(id);
      }
      entries = entries.filter(e => !selectedIds.has(e.id));
      const count = selectedIds.size;
      selectedIds.clear();
      showToast(`${count} entries deleted`);
    } else {
      await supabase.remove(deleteTarget);
      entries = entries.filter(e => e.id !== deleteTarget);
      selectedIds.delete(deleteTarget);
      showToast('Entry deleted');
    }
    deleteModal.style.display = 'none';
    deleteTarget = null;
    renderEntries();
  } catch (err) {
    console.error(err);
    showToast('Error deleting — check console');
  }
}

// ---- Copy for Claude ----
function formatForClaude(entryList) {
  return entryList.map(e => {
    let block = `## ${e.title}\n`;
    block += `**Category:** ${e.category}\n`;
    if (e.source) block += `**Source:** ${e.source}\n`;
    if (e.tags?.length) block += `**Tags:** ${e.tags.join(', ')}\n`;
    block += `\n${e.content}`;
    return block;
  }).join('\n\n---\n\n');
}

function copyForClaude(entryList) {
  const text = `<context>\nThe following are entries from my Commonplace Book — a curated collection of quotes, ideas, references, reflections, and frameworks.\n\n${formatForClaude(entryList)}\n</context>`;
  navigator.clipboard.writeText(text).then(() => {
    showToast(`Copied ${entryList.length} entr${entryList.length === 1 ? 'y' : 'ies'} for Claude`);
  }).catch(() => showToast('Copy failed — check browser permissions'));
}

// ---- Export / Import ----
function exportJSON(entryList, filename = 'commonplace-book-export.json') {
  const blob = new Blob([JSON.stringify(entryList, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast(`Exported ${entryList.length} entries`);
}

async function importJSON(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const arr = Array.isArray(data) ? data : [data];
    let count = 0;
    for (const item of arr) {
      const entry = {
        title: item.title || 'Untitled',
        category: item.category || 'Ideas',
        source: item.source || '',
        content: item.content || '',
        tags: item.tags || [],
      };
      const created = await supabase.insert(entry);
      if (created) { entries.unshift(created); count++; }
    }
    renderEntries();
    showToast(`Imported ${count} entries`);
  } catch (err) {
    console.error(err);
    showToast('Import failed — check file format');
  }
}

// ---- Selection ----
function toggleSelection(id) {
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
  renderEntries();
}

// ---- Event Listeners ----
// New entry
$('#btn-new-entry').addEventListener('click', () => openModal());
$('#btn-empty-new').addEventListener('click', () => openModal());

// Modal
$('#btn-modal-close').addEventListener('click', closeModal);
$('#btn-modal-cancel').addEventListener('click', closeModal);
$('#btn-modal-save').addEventListener('click', saveEntry);
entryModal.addEventListener('click', (e) => { if (e.target === entryModal) closeModal(); });

// Delete modal
$('#btn-delete-cancel').addEventListener('click', () => { deleteModal.style.display = 'none'; });
$('#btn-delete-confirm').addEventListener('click', executeDelete);
deleteModal.addEventListener('click', (e) => { if (e.target === deleteModal) deleteModal.style.display = 'none'; });

// Keyboard
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (deleteModal.style.display === 'flex') deleteModal.style.display = 'none';
    else if (entryModal.style.display === 'flex') closeModal();
  }
  if (e.key === 'Enter' && e.ctrlKey && entryModal.style.display === 'flex') {
    saveEntry();
  }
});

// Search & filters
searchInput.addEventListener('input', renderEntries);
filterCategory.addEventListener('change', renderEntries);
sortBy.addEventListener('change', renderEntries);

// Grid delegation
grid.addEventListener('click', (e) => {
  const card = e.target.closest('.entry-card');
  if (!card) return;
  const id = card.dataset.id;

  // Checkbox
  if (e.target.classList.contains('card-checkbox')) {
    toggleSelection(id);
    return;
  }
  // Edit
  if (e.target.closest('.card-action-btn.edit')) {
    const entry = entries.find(en => en.id == id);
    if (entry) openModal(entry);
    return;
  }
  // Copy single
  if (e.target.closest('.card-action-btn.copy-single')) {
    const entry = entries.find(en => en.id == id);
    if (entry) copyForClaude([entry]);
    return;
  }
  // Delete
  if (e.target.closest('.card-action-btn.delete')) {
    confirmDelete(id);
    return;
  }
});

// Selection actions
$('#btn-copy-claude').addEventListener('click', () => {
  const selected = entries.filter(e => selectedIds.has(e.id));
  if (selected.length) copyForClaude(selected);
});
$('#btn-export-selected').addEventListener('click', () => {
  const selected = entries.filter(e => selectedIds.has(e.id));
  if (selected.length) exportJSON(selected, 'commonplace-selected.json');
});
$('#btn-delete-selected').addEventListener('click', () => {
  if (selectedIds.size) confirmDelete('selected');
});
$('#btn-clear-selection').addEventListener('click', () => {
  selectedIds.clear();
  renderEntries();
});

// Import / Export all
$('#btn-export').addEventListener('click', () => exportJSON(entries));
$('#btn-import').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) importJSON(file);
  e.target.value = '';
});

// ---- Init ----
async function init() {
  loadingState.style.display = 'block';
  grid.style.display = 'none';
  emptyState.style.display = 'none';
  try {
    entries = await supabase.fetchAll() || [];
    loadingState.style.display = 'none';
    renderEntries();
  } catch (err) {
    console.error('Failed to load entries:', err);
    loadingState.innerHTML = `
      <p style="color:var(--danger);font-weight:500;">Failed to connect to database</p>
      <p style="font-size:0.85rem;margin-top:8px;color:var(--text-tertiary);">Check your Supabase URL, anon key, and that the "entries" table exists with RLS policies.</p>
    `;
  }
}

init();
