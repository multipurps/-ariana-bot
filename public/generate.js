// ══════════════════════════════════════════════════════════════
// GENERATE.JS — Studio, Wardrobe, Face Lock
// All storage goes through the backend → Supabase (no localStorage for files)
// ══════════════════════════════════════════════════════════════

// ── STATE ──
let genMode     = 'pimg';
let genProvider = 'fal';
let ttsProv     = 'cartesia';
let genFileSrcs = {};
let wardrobeItems = [];
let selectedOutfitId = null;
let faceLockData = { on:false, face:[], body:[], env:[], facePrompt:'', bodyPrompt:'', envPrompt:'' };
let genLastResult = null;

const GEN_PROVIDERS = {
  pimg:   ['fal','replicate','stability'],
  i2i:    ['fal','replicate'],
  pvid:   ['fal','runway'],
  nsfw:   ['fal'],
  motion: ['fal','runway'],
  tts:    []
};

// ── INIT ──
function initGenerateView() {
  const savedMode = sessionStorage.getItem('gen_mode') || 'pimg';
  const chip = document.querySelector(`.gen-chip[data-mode="${savedMode}"]`);
  setGenMode(savedMode, chip || document.querySelector('.gen-chip'));
  loadGenKey();
  updateLockBar();
}

// ── MODE ──
function setGenMode(mode, el) {
  genMode = mode;
  sessionStorage.setItem('gen_mode', mode);
  document.querySelectorAll('.gen-chip').forEach(c => c.classList.remove('active'));
  if (el) el.classList.add('active');

  // Show/hide mode panels
  document.querySelectorAll('.gen-mode-panel').forEach(p => p.style.display = 'none');
  const panel = document.querySelector(`.gen-mode-panel[data-panel="${mode}"]`);
  if (panel) panel.style.display = '';

  // Prompt card
  const pc = document.getElementById('gc-prompt-card');
  if (pc) pc.style.display = mode === 'tts' ? 'none' : '';

  // Provider card
  const prc = document.getElementById('gc-provider-card');
  if (prc) prc.style.display = mode === 'tts' ? 'none' : '';

  // Update providers shown
  updateProviderChips(mode);

  // Button label / style
  const btn = document.getElementById('gen-btn');
  if (btn) {
    btn.textContent = mode === 'tts' ? 'Generate Speech' : 'Generate';
    btn.classList.toggle('nsfw-mode', mode === 'nsfw');
  }
}

function updateProviderChips(mode) {
  const available = GEN_PROVIDERS[mode] || [];
  document.querySelectorAll('#gen-prov-row .gc-prov-chip').forEach(c => {
    const prov = c.dataset.prov;
    c.style.display = available.includes(prov) ? '' : 'none';
  });
  if (!available.includes(genProvider) && available.length) {
    setGenProvider(available[0], document.querySelector(`#gen-prov-row .gc-prov-chip[data-prov="${available[0]}"]`));
  }
}

function setGenProvider(prov, el) {
  genProvider = prov;
  document.querySelectorAll('#gen-prov-row .gc-prov-chip').forEach(c => c.classList.remove('active'));
  if (el) el.classList.add('active');
  loadGenKey();
}

function loadGenKey() {
  const stored = JSON.parse(sessionStorage.getItem('_genKeys') || '{}');
  const inp = document.getElementById('gen-key-input');
  if (inp && stored[genProvider]) inp.value = '•'.repeat(16);
}

function genSaveKey() {
  const inp = document.getElementById('gen-key-input');
  if (!inp || inp.value.includes('•')) return;
  const keys = JSON.parse(sessionStorage.getItem('_genKeys') || '{}');
  keys[genProvider] = inp.value.trim();
  sessionStorage.setItem('_genKeys', JSON.stringify(keys));
}

function getGenKey() {
  const inp = document.getElementById('gen-key-input');
  if (inp && !inp.value.includes('•') && inp.value.trim()) return inp.value.trim();
  const keys = JSON.parse(sessionStorage.getItem('_genKeys') || '{}');
  return keys[genProvider] || '';
}

// ── FILE PICKS ──
function genPickFile(inp, slot) {
  const file = inp.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    genFileSrcs[slot] = e.target.result;
    const prev = document.getElementById(`gen-${slot}-prev`);
    const ph   = document.getElementById(`gen-${slot}-ph`);
    if (prev) { prev.src = e.target.result; prev.style.display = 'block'; }
    if (ph)   ph.style.display = 'none';
  };
  reader.readAsDataURL(file);
}

function genUseFaceLock() {
  const faceImgs = faceLockData.face;
  if (!faceImgs.length) { alert('No face lock set. Go to Profile to upload face photos.'); return; }
  genFileSrcs['mot'] = faceImgs[0].url;
  const prev = document.getElementById('gen-mot-prev');
  const ph   = document.getElementById('gen-mot-ph');
  if (prev) { prev.src = faceImgs[0].url; prev.style.display = 'block'; }
  if (ph)   ph.style.display = 'none';
}

// ── BUILD PROMPT ──
function buildGenPrompt() {
  const parts = [];
  if (faceLockData.on) {
    if (faceLockData.facePrompt) parts.push(faceLockData.facePrompt.trim());
    if (faceLockData.bodyPrompt) parts.push(faceLockData.bodyPrompt.trim());
    if (faceLockData.envPrompt)  parts.push(faceLockData.envPrompt.trim());
  }
  const outfit = wardrobeItems.find(w => w.id === selectedOutfitId);
  if (outfit) parts.push(`wearing ${outfit.name}`);
  const user = (document.getElementById('gen-prompt')?.value || '').trim();
  if (user) parts.push(user);
  return parts.join(', ');
}

// ── LOCK BAR ──
function updateLockBar() {
  const faceOn  = faceLockData.on && (faceLockData.face.length > 0 || faceLockData.facePrompt);
  const bodyOn  = faceLockData.on && (faceLockData.body.length > 0 || faceLockData.bodyPrompt);
  const outfit  = wardrobeItems.find(w => w.id === selectedOutfitId);

  const pFace = document.getElementById('glp-face');
  const pBody = document.getElementById('glp-body');
  const pOut  = document.getElementById('glp-outfit');

  if (pFace) { pFace.classList.toggle('on', faceOn); document.getElementById('glp-face-txt').textContent = faceOn ? 'Face: On' : 'Face'; }
  if (pBody) { pBody.classList.toggle('on', bodyOn); document.getElementById('glp-body-txt').textContent = bodyOn ? 'Body: On' : 'Body'; }
  if (pOut)  { pOut.classList.toggle('outfit-on', !!outfit); document.getElementById('glp-outfit-txt').textContent = outfit ? outfit.name : 'Outfit'; }
}

function openFaceLockFromGen() {
  navTo({ dataset: { view: 'profile' } });
}

// ── RUN GENERATE ──
async function runGenerate() {
  const apiKey = getGenKey();
  const canvas = document.getElementById('gen-canvas');

  if (genMode === 'tts') {
    const text    = document.getElementById('gen-tts-text')?.value.trim();
    const voiceId = document.getElementById('gen-tts-voice')?.value.trim();
    if (!text)    { alert('Enter text to speak'); return; }
    if (!voiceId) { alert('Select or enter a Voice ID'); return; }
    if (!apiKey)  { alert('Paste your API key for the selected TTS provider'); return; }
    setGenLoading(true, 'Synthesising...');
    try {
      const r = await fetch('/api/generate/tts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voiceId, provider: ttsProv, apiKey })
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'TTS failed');
      setGenLoading(false);
      const aud = document.getElementById('gen-out-aud');
      if (aud) { aud.src = d.audioUrl; aud.style.display = 'block'; }
      canvas?.classList.add('has-result');
      genLastResult = { type: 'audio', url: d.audioUrl };
    } catch (e) { setGenLoading(false); alert('TTS error: ' + e.message); }
    return;
  }

  if (!apiKey) { alert('Paste your API key above'); return; }
  const fullPrompt = buildGenPrompt();
  if (!fullPrompt) { alert('Write a prompt first'); return; }

  const fl = faceLockData;
  const faceUrl   = fl.on && fl.face.length  ? fl.face[0].url  : null;
  const bodyUrl   = fl.on && fl.body.length  ? fl.body[0].url  : null;
  const outfit    = wardrobeItems.find(w => w.id === selectedOutfitId);
  const outfitUrl = outfit ? outfit.url : null;

  let endpoint, body;

  if (genMode === 'nsfw') {
    const nudeOn = document.getElementById('gen-nude-tgl')?.classList.contains('on');
    const base   = nudeOn ? 'NSFW, explicit nudity, fully nude, realistic skin texture, ' : 'NSFW, sensual, intimate, suggestive, ';
    endpoint = '/api/generate/nsfw';
    body = { prompt: base + fullPrompt, faceUrl: genFileSrcs['nsfw'] || faceUrl, bodyUrl, outfitUrl, provider: genProvider, apiKey };
  } else if (genMode === 'i2i') {
    const src = genFileSrcs['i2i'] || faceUrl;
    if (!src) { alert('Upload a source image or set Face Lock'); return; }
    endpoint = '/api/generate/image';
    body = { prompt: fullPrompt, imageUrl: src, strength: parseFloat(document.getElementById('gen-i2i-strength')?.value || '0.75'), faceUrl, bodyUrl, outfitUrl, provider: genProvider, apiKey };
  } else if (genMode === 'motion') {
    const src = genFileSrcs['mot'] || faceUrl;
    if (!src) { alert('Upload an image or use Face Lock as source'); return; }
    endpoint = '/api/generate/motion';
    body = { prompt: fullPrompt, imageUrl: src, faceUrl, bodyUrl, outfitUrl, provider: genProvider, apiKey };
  } else if (genMode === 'pvid') {
    endpoint = '/api/generate/video';
    body = { prompt: fullPrompt, faceUrl, bodyUrl, outfitUrl, provider: genProvider, apiKey };
  } else {
    endpoint = '/api/generate/image';
    body = { prompt: fullPrompt, faceUrl, bodyUrl, outfitUrl, provider: genProvider, apiKey };
  }

  setGenLoading(true, 'Generating...');
  try {
    const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!d.ok && !d.url && !d.pollId) throw new Error(d.error || 'Generation failed');
    if (d.pollId) {
      await pollGenResult(d.pollId, genProvider, apiKey);
    } else {
      showGenResult(d);
    }
  } catch (e) { setGenLoading(false); alert('Error: ' + e.message); }
}

function setGenLoading(on, txt = 'Generating...') {
  const canvas = document.getElementById('gen-canvas');
  const loader = document.getElementById('gen-canvas-loader-txt');
  const btn    = document.getElementById('gen-btn');
  if (canvas) canvas.classList.toggle('loading', on);
  if (loader) loader.textContent = txt;
  if (btn) { btn.disabled = on; btn.textContent = on ? txt : (genMode === 'tts' ? 'Generate Speech' : 'Generate'); }
}

function showGenResult(d) {
  setGenLoading(false);
  const canvas = document.getElementById('gen-canvas');
  const img    = document.getElementById('gen-out-img');
  const vid    = document.getElementById('gen-out-vid');
  const aud    = document.getElementById('gen-out-aud');
  if (!canvas) return;
  canvas.classList.add('has-result');
  const url = d.url || d.urls?.[0];
  if (!url) return;
  genLastResult = { type: genMode === 'motion' || genMode === 'pvid' ? 'video' : 'image', url };
  if (genMode === 'motion' || genMode === 'pvid') {
    if (img) img.style.display = 'none';
    if (aud) aud.style.display = 'none';
    if (vid) { vid.src = url; vid.style.display = 'block'; }
  } else {
    if (vid) vid.style.display = 'none';
    if (aud) aud.style.display = 'none';
    if (img) { img.src = url; img.style.display = 'block'; }
  }
}

async function pollGenResult(pollId, provider, apiKey, attempts = 0) {
  if (attempts > 60) { setGenLoading(false); alert('Generation timed out. Try again.'); return; }
  setGenLoading(true, `Generating... (${Math.round(attempts * 3)}s)`);
  await new Promise(r => setTimeout(r, 3000));
  try {
    const r = await fetch(`/api/generate/poll/${provider}/${pollId}?apiKey=${encodeURIComponent(apiKey)}`);
    const d = await r.json();
    if (d.status === 'ready' || d.url || d.urls) { showGenResult(d); }
    else if (d.status === 'failed') { setGenLoading(false); alert('Generation failed: ' + (d.error || 'Unknown error')); }
    else { await pollGenResult(pollId, provider, apiKey, attempts + 1); }
  } catch (e) { setGenLoading(false); alert('Poll error: ' + e.message); }
}

function genSaveResult() {
  if (!genLastResult) return;
  if (typeof saveLib === 'function') saveLib(genLastResult.type, genLastResult.url, 'generate');
  if (typeof showSaveToast === 'function') showSaveToast();
}

function genDownloadResult() {
  if (!genLastResult) return;
  const a = document.createElement('a');
  a.href = genLastResult.url;
  a.download = `ariana_${genMode}_${Date.now()}.${genLastResult.type === 'video' ? 'mp4' : genLastResult.type === 'audio' ? 'mp3' : 'jpg'}`;
  a.click();
}

// ── TTS ──
function setTtsProv(p, el) {
  ttsProv = p;
  document.querySelectorAll('#gen-tts-panel .gc-prov-chip, #outfit-picker .gc-prov-chip').forEach(c => c.classList.remove('active'));
  document.querySelectorAll(`[id^="tts-prov"]`).forEach(c => c.classList.remove('active'));
  if (el) el.classList.add('active');
  const presetLabel = document.getElementById('tts-preset-label');
  const presetGrid  = document.getElementById('gen-tts-presets');
  if (presetLabel) presetLabel.style.display = p === 'cartesia' ? '' : 'none';
  if (presetGrid)  presetGrid.style.display  = p === 'cartesia' ? '' : 'none';
  const inp = document.getElementById('gen-tts-voice');
  if (inp) inp.placeholder = p === 'elevenlabs' ? 'ElevenLabs Voice ID...' : 'Cartesia Voice ID...';
}

function pickTtsVoice(btn) {
  document.querySelectorAll('.gc-voice-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const inp = document.getElementById('gen-tts-voice');
  if (inp) inp.value = btn.dataset.id;
}

// ══════════════════════════════════════════════════════════════
// WARDROBE
// ══════════════════════════════════════════════════════════════

async function initWardrobeView() {
  await loadWardrobeFromServer();
  renderWardrobeGrid();
}

async function loadWardrobeFromServer() {
  try {
    const r = await fetch('/api/wardrobe');
    const d = await r.json();
    if (d.ok) wardrobeItems = d.items || [];
  } catch (e) { console.warn('Wardrobe load failed:', e.message); }
}

function renderWardrobeGrid() {
  const grid  = document.getElementById('wardrobe-grid');
  const empty = document.getElementById('wardrobe-empty');
  const count = document.getElementById('wardrobe-count-badge');
  if (count) count.textContent = wardrobeItems.length + ' outfit' + (wardrobeItems.length !== 1 ? 's' : '');
  if (!grid) return;
  if (!wardrobeItems.length) { grid.innerHTML = ''; if (empty) empty.style.display = 'block'; return; }
  if (empty) empty.style.display = 'none';
  grid.innerHTML = wardrobeItems.map(item => `
    <div class="wcard ${item.id === selectedOutfitId ? 'selected' : ''}" onclick="selectWardrobe('${item.id}')">
      <img src="${item.url}" alt="${escHtml(item.name)}" loading="lazy">
      <div class="wcard-name">${escHtml(item.name)}</div>
    </div>`).join('');
  const selTxt   = document.getElementById('wardrobe-sel-txt');
  const selClear = document.getElementById('wardrobe-sel-clear');
  const selItem  = wardrobeItems.find(w => w.id === selectedOutfitId);
  if (selTxt)   selTxt.textContent = selItem ? `Selected: ${selItem.name}` : 'Tap an outfit to select it for all generations';
  if (selClear) selClear.style.display = selItem ? '' : 'none';
}

async function addWardrobeItems(inp) {
  const files = [...inp.files]; if (!files.length) return;
  let done = 0;
  for (const file of files) {
    const b64 = await fileToBase64(file);
    try {
      const r = await fetch('/api/wardrobe/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name.replace(/\.[^.]+$/, ''), data: b64, mimeType: file.type })
      });
      const d = await r.json();
      if (d.ok && d.item) wardrobeItems.push(d.item);
    } catch (e) { console.warn('Upload failed:', e.message); }
    done++;
  }
  inp.value = '';
  renderWardrobeGrid();
  renderOutfitPickerGrid();
  updateLockBar();
}

function selectWardrobe(id) {
  selectedOutfitId = selectedOutfitId === id ? null : id;
  renderWardrobeGrid();
  renderOutfitPickerGrid();
  updateLockBar();
}

function clearOutfitSelection() {
  selectedOutfitId = null;
  renderWardrobeGrid();
  updateLockBar();
}

// ── OUTFIT PICKER (dropdown in generate) ──
async function openOutfitPicker() {
  if (!wardrobeItems.length) await loadWardrobeFromServer();
  renderOutfitPickerGrid();
  const picker = document.getElementById('outfit-picker');
  if (picker) picker.classList.add('open');
}

function closeOutfitPicker() {
  const picker = document.getElementById('outfit-picker');
  if (picker) picker.classList.remove('open');
  updateLockBar();
}

function renderOutfitPickerGrid() {
  const grid  = document.getElementById('outfit-picker-grid');
  const empty = document.getElementById('outfit-picker-empty');
  if (!grid) return;
  if (!wardrobeItems.length) { grid.innerHTML = ''; if (empty) empty.style.display = 'block'; return; }
  if (empty) empty.style.display = 'none';
  grid.innerHTML = wardrobeItems.map(item => `
    <div class="op-card ${item.id === selectedOutfitId ? 'selected' : ''}" onclick="selectOutfitPicker('${item.id}')">
      <img src="${item.url}" alt="${escHtml(item.name)}" loading="lazy">
      <div class="op-card-name">${escHtml(item.name)}</div>
    </div>`).join('');
}

function selectOutfitPicker(id) {
  selectedOutfitId = selectedOutfitId === id ? null : id;
  renderOutfitPickerGrid();
  updateLockBar();
}

// ══════════════════════════════════════════════════════════════
// FACE LOCK (profile)
// ══════════════════════════════════════════════════════════════

async function initFaceLockSection() {
  try {
    const r = await fetch('/api/facelock');
    const d = await r.json();
    if (d.ok) {
      faceLockData.face = d.items.filter(i => i.slot === 'face');
      faceLockData.body = d.items.filter(i => i.slot === 'body');
      faceLockData.env  = d.items.filter(i => i.slot === 'env');
    }
  } catch (e) { console.warn('Face lock load:', e.message); }
  faceLockData.on          = localStorage.getItem('fl_on') === '1';
  faceLockData.facePrompt  = localStorage.getItem('fl_face_prompt') || '';
  faceLockData.bodyPrompt  = localStorage.getItem('fl_body_prompt') || '';
  faceLockData.envPrompt   = localStorage.getItem('fl_env_prompt')  || '';
  renderFaceLockSection();
  updateLockBar();
}

function renderFaceLockSection() {
  const tgl = document.getElementById('prof-fl-toggle');
  if (tgl) tgl.classList.toggle('on', faceLockData.on);
  ['face','body','env'].forEach(slot => {
    const row = document.getElementById(`fl-${slot}-row`);
    if (!row) return;
    const items = faceLockData[slot];
    const thumbsEl = row.querySelector('.fl-photos-row');
    if (thumbsEl) {
      thumbsEl.innerHTML = items.map(img => `
        <div class="fl-thumb">
          <img src="${img.url}" alt="">
          <div class="fl-thumb-del" onclick="deleteFaceLockImg('${img.id}','${slot}')">&#10005;</div>
        </div>`).join('') +
        `<label class="fl-add-btn" for="fl-${slot}-file">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          <span>Add</span>
        </label>`;
    }
    const promptEl = document.getElementById(`fl-${slot}-prompt`);
    if (promptEl) promptEl.value = faceLockData[`${slot}Prompt`];
  });
}

function toggleFaceLock() {
  faceLockData.on = !faceLockData.on;
  localStorage.setItem('fl_on', faceLockData.on ? '1' : '0');
  const tgl = document.getElementById('prof-fl-toggle');
  if (tgl) tgl.classList.toggle('on', faceLockData.on);
  updateLockBar();
}

async function uploadFaceLockImg(inp, slot) {
  const files = [...inp.files]; if (!files.length) return;
  for (const file of files) {
    const b64 = await fileToBase64(file);
    try {
      const r = await fetch('/api/facelock/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slot, data: b64, mimeType: file.type })
      });
      const d = await r.json();
      if (d.ok && d.item) faceLockData[slot].push(d.item);
    } catch (e) { alert('Upload failed: ' + e.message); }
  }
  inp.value = '';
  renderFaceLockSection();
  updateLockBar();
}

async function deleteFaceLockImg(id, slot) {
  try {
    await fetch(`/api/facelock/${id}`, { method: 'DELETE' });
    faceLockData[slot] = faceLockData[slot].filter(i => i.id !== id);
    renderFaceLockSection();
    updateLockBar();
  } catch (e) { alert('Delete failed: ' + e.message); }
}

function saveFaceLockPrompt(slot) {
  const val = (document.getElementById(`fl-${slot}-prompt`)?.value || '').trim();
  faceLockData[`${slot}Prompt`] = val;
  localStorage.setItem(`fl_${slot}_prompt`, val);
  updateLockBar();
}

// ── UTIL ──
function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = e => res(e.target.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
