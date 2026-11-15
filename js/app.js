import { db } from './db.js';
import { ICONS } from './icons.js';
import { Listener } from './audio.js';
import { importDocx, LINKTEXT } from './docx.js';
import { nameKey, parseFilename, needsDiagram, diagramSVG } from './chords.js';

const APP_VERSION = '1.1.0';
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (n, label = '') => `<span class="ic" aria-hidden="true">${ICONS[n] || ''}</span>${label ? `<span class="lbl">${esc(label)}</span>` : ''}`;
const btn = (n, label, attrs = '', showLabel = false) => `<button class="ib" aria-label="${esc(label)}" title="${esc(label)}" ${attrs}>${icon(n, showLabel ? label : '')}</button>`;
const flames = (n, size = 'sm') => `<span class="flames ${size}" aria-label="Confidence ${n} of 5">${[1, 2, 3, 4, 5].map(i => `<span class="fl ${i <= n ? 'on' : 'off'}">${ICONS[i <= n ? 'flame' : 'flame_outline']}</span>`).join('')}</span>`;

const S = {
  songs: [], byId: new Map(), setlists: [], speeds: {},
  settings: { theme: 'day', threshold: 35, hangover: 1.5, speed: 12, textScale: 1, sort: 'title', tab: 'all', filter: [], lastBackup: 0, dirty: false, backupNag: 0 },
  listener: new Listener(), wake: null, raf: 0, query: '',
};

// ---------- persistence ----------
async function load() {
  S.songs = await db.allSongs();
  S.byId = new Map(S.songs.map(s => [s.id, s]));
  S.setlists = await db.getMeta('setlists', []);
  S.speeds = await db.getMeta('speeds', {});
  Object.assign(S.settings, await db.getMeta('settings', {}));
  applyTheme();
}
const saveSettings = () => db.setMeta('settings', S.settings);
const saveSetlists = () => { markDirty(); return db.setMeta('setlists', S.setlists); };
const saveSpeeds = () => db.setMeta('speeds', S.speeds);
function markDirty() { S.settings.dirty = true; saveSettings(); }
function applyTheme() {
  document.documentElement.dataset.theme = S.settings.theme;
  $('meta[name=theme-color]').setAttribute('content', S.settings.theme === 'night' ? '#10162B' : '#1E2A4F');
}

// ---------- ui helpers ----------
function toast(msg, ms = 3500) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, ms);
}
function dialog(html, { onOpen } = {}) {
  return new Promise(resolve => {
    const wrap = document.createElement('div'); wrap.className = 'modal';
    wrap.innerHTML = `<div class="dlg" role="dialog" aria-modal="true">${html}</div>`;
    document.body.appendChild(wrap);
    const close = (v) => { wrap.remove(); resolve(v); };
    wrap.addEventListener('click', e => { if (e.target === wrap) close(null); const b = e.target.closest('[data-v]'); if (b) close(b.dataset.v === 'input' ? $('input', wrap).value : b.dataset.v); });
    if (onOpen) onOpen(wrap, close);
    const inp = $('input[type=text]', wrap); if (inp) { inp.focus(); inp.addEventListener('keydown', e => { if (e.key === 'Enter') close(inp.value); }); }
  });
}
const confirmBox = (msg, yes = 'Delete') => dialog(`<p class="q">${esc(msg)}</p><div class="row end"><button class="tb" data-v="no">${icon('cancel', 'Cancel')}</button><button class="tb danger" data-v="yes">${icon('confirm', yes)}</button></div>`).then(v => v === 'yes');
const promptBox = (msg, val = '') => dialog(`<p class="q">${esc(msg)}</p><input type="text" value="${esc(val)}" class="inp"><div class="row end"><button class="tb" data-v="">${icon('cancel', 'Cancel')}</button><button class="tb primary" data-v="input">${icon('confirm', 'OK')}</button></div>`);

function topbar(left, title, right = '', sub = '') {
  return `<header class="top">${left}<div class="ttl"><div class="t1">${title}</div>${sub ? `<div class="t2">${sub}</div>` : ''}</div><div class="acts">${right}</div></header>`;
}
const themeBtn = () => btn(S.settings.theme === 'night' ? 'day_mode' : 'night_mode', S.settings.theme === 'night' ? 'Day mode' : 'Night mode', 'data-act="theme"');

// ---------- router ----------
function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
window.addEventListener('hashchange', route);
function route() {
  leaveSong();
  const h = location.hash.slice(1) || '/';
  const [path, qs] = h.split('?');
  const q = new URLSearchParams(qs || '');
  const parts = path.split('/').filter(Boolean);
  window.scrollTo(0, 0);
  if (parts[0] === 'song') return viewSong(decodeURIComponent(parts[1]), q.get('set'), parseInt(q.get('i') || '-1', 10));
  if (parts[0] === 'setlists') return viewSetlists();
  if (parts[0] === 'setlist') return viewSetlist(parts[1]);
  if (parts[0] === 'chords') return viewChords();
  if (parts[0] === 'settings') return viewSettings();
  return viewLibrary();
}
document.addEventListener('click', e => {
  const a = e.target.closest('[data-act]'); if (!a) return;
  const act = a.dataset.act;
  if (act === 'theme') { S.settings.theme = S.settings.theme === 'night' ? 'day' : 'night'; saveSettings(); applyTheme(); route(); }
  if (act === 'home') go('#/');
  if (act === 'back') history.length > 1 ? history.back() : go('#/');
  if (act === 'setlists') go('#/setlists');
  if (act === 'chords') go('#/chords');
  if (act === 'settings') go('#/settings');
});

// ---------- library ----------
function songSub(s) {
  if (s.type === 'own') return 'Erik' + (s.basedOn ? ` · Based on: ${s.basedOn.title}${s.basedOn.artist ? ' - ' + s.basedOn.artist : ''}` : '');
  return s.artist || '';
}
function filteredSongs() {
  const q = S.query.trim().toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  let list = S.songs.filter(s => (S.settings.tab === 'own' ? s.type === 'own' : true));
  if (S.settings.filter.length) list = list.filter(s => S.settings.filter.includes(s.score));
  if (terms.length) list = list.filter(s => {
    const hay = [s.title, s.artist, s.basedOn?.title, s.basedOn?.artist].filter(Boolean).join(' ').toLowerCase();
    return terms.every(t => hay.includes(t));
  });
  const key = S.settings.sort === 'artist' ? (s) => (s.type === 'own' ? 'erik' : (s.artist || '').toLowerCase().replace(/^the /, '')) + '\u0000' + s.title.toLowerCase() : (s) => s.title.toLowerCase().replace(/^['(]/, '');
  return list.sort((a, b) => key(a).localeCompare(key(b), 'nl'));
}
function viewLibrary() {
  const app = $('#app');
  const nagDue = S.songs.length && S.settings.dirty && Date.now() - Math.max(S.settings.lastBackup || 0, S.settings.firstUse || Date.now()) > 14 * 864e5 && Date.now() - (S.settings.backupNag || 0) > 864e5;
  app.innerHTML = topbar(`<img class="logo" src="icons/favicon-48.png" alt="">`, "Erik's Campfire Music", `${btn('setlists', 'Setlists', 'data-act="setlists"')}${btn('chord_dictionary', 'Chords', 'data-act="chords"')}${themeBtn()}${btn('settings', 'Settings', 'data-act="settings"')}`) +
    `<main class="lib">
      ${nagDue ? `<div class="nag">${icon('backup_export')}<span>Time for a backup of your songs, scores and setlists.</span><button class="tb primary" id="nagb">Back up now</button><button class="tb" id="nagx">Later</button></div>` : ''}
      ${S.songs.length ? `
      <div class="searchrow"><span class="ic">${ICONS.search}</span><input id="q" type="search" placeholder="Search title or artist" value="${esc(S.query)}" autocomplete="off"></div>
      <div class="tabs" role="tablist">
        <button class="tab ${S.settings.tab !== 'own' ? 'on' : ''}" data-tab="all">${icon('song_library', 'All songs')}</button>
        <button class="tab ${S.settings.tab === 'own' ? 'on' : ''}" data-tab="own">${icon('edit', 'My Own Creations')}</button>
      </div>
      <div class="filters">
        <span class="ic fic" title="Filter on confidence">${ICONS.filter}</span>
        ${[1, 2, 3, 4, 5].map(n => `<button class="chip ${S.settings.filter.includes(n) ? 'on' : ''}" data-f="${n}" aria-pressed="${S.settings.filter.includes(n)}">${flames(n, 'xs')}</button>`).join('')}
        <button class="chip sort" id="sort" aria-label="Sort A to Z">${icon('sort_a_to_z')}<span>${S.settings.sort === 'artist' ? 'Artist A to Z' : 'Title A to Z'}</span></button>
      </div>
      <div class="count" id="count"></div>
      <ul class="songs" id="list"></ul>` : `
      <div class="empty"><img src="img/splash.jpg" alt="" class="emptyimg"><h2>Welcome, Erik</h2><p>Import your songs to get started: choose the file <b>campfire-data.json</b> (from your Drive folder) or a backup.</p>
      <label class="tb primary big">${icon('import_song', 'Import songs')}<input type="file" id="firstimp" accept=".json,.docx,.doc,application/json" multiple hidden></label></div>`}
    </main>`;
  const list = $('#list');
  const draw = () => {
    if (!list) return;
    const songs = filteredSongs();
    $('#count').textContent = `${songs.length} song${songs.length === 1 ? '' : 's'}`;
    list.innerHTML = songs.map(s => `<li><a class="song" href="#/song/${encodeURIComponent(s.id)}"><div class="st"><div class="t1">${esc(s.title)}</div><div class="t2">${esc(songSub(s))}</div></div><div class="sr">${s.capo ? `<span class="capob">${icon('capo')}${s.capo}</span>` : ''}${flames(s.score)}</div></a></li>`).join('');
  };
  draw();
  const q = $('#q');
  if (q) q.addEventListener('input', () => { S.query = q.value; draw(); });
  app.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { S.settings.tab = b.dataset.tab; saveSettings(); viewLibrary(); });
  app.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { const n = +b.dataset.f; const f = S.settings.filter; S.settings.filter = f.includes(n) ? f.filter(x => x !== n) : [...f, n]; saveSettings(); viewLibrary(); });
  const so = $('#sort'); if (so) so.onclick = () => { S.settings.sort = S.settings.sort === 'artist' ? 'title' : 'artist'; saveSettings(); viewLibrary(); };
  const fi = $('#firstimp'); if (fi) fi.onchange = () => importFiles([...fi.files]);
  const nb = $('#nagb'); if (nb) nb.onclick = exportBackup;
  const nx = $('#nagx'); if (nx) nx.onclick = () => { S.settings.backupNag = Date.now(); saveSettings(); viewLibrary(); };
}

// ---------- song view ----------
let song = null, ctx = null;
function leaveSong() {
  cancelAnimationFrame(S.raf); S.raf = 0;
  if (S.wake) { S.wake.release().catch(() => {}); S.wake = null; }
  if (S.listener.active && !location.hash.startsWith('#/settings') && !location.hash.startsWith('#/song')) S.listener.stop();
  document.body.classList.remove('insong');
  window.onresize = null;
  window.onkeydown = null;
}
async function keepAwake() {
  try { if ('wakeLock' in navigator) S.wake = await navigator.wakeLock.request('screen'); } catch (e) { /* ignore */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && document.body.classList.contains('insong')) keepAwake(); });

// A plain text line may wrap only when it is ordinary prose (no tab notation, no column layout).
const isProse = (t) => !/-{3,}|\||\S {3,}\S/.test(t.trimEnd());
function lineHTML(l) {
  const [k, t, ex] = l;
  if (k === 'i') return `<div class="ln k-i"><img data-img="${esc(t)}" alt=""></div>`;
  let html;
  if (ex && ex.split !== undefined) html = `<span class="ch">${esc(t.slice(0, ex.split))}</span><span class="rm">${esc(t.slice(ex.split))}</span>`;
  else html = esc(t);
  if (ex && ex.link) html = html.replace(esc(LINKTEXT), `<a href="${esc(ex.link)}" target="_blank" rel="noopener">${esc(LINKTEXT)}</a>`);
  return `<div class="ln k-${k}${k === 't' && isProse(t) ? ' wrap' : ''}">${html || '&nbsp;'}</div>`;
}
const SPEED_STEP = 2, SPEED_MIN = 1, SPEED_MAX = 80;
const getSpeed = () => S.speeds[song.id] ?? S.settings.speed;
function showSpeed() { const el = $('#speedv'); if (el) el.textContent = Math.round(getSpeed()); }
function setSpeed(v) { S.speeds[song.id] = Math.round(Math.min(SPEED_MAX, Math.max(SPEED_MIN, v)) * 10) / 10; saveSpeeds(); markDirty(); showSpeed(); }
function nudgeSpeed(d) { setSpeed(getSpeed() + d); const el = $('#speedv'); if (el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); } }

// Learning: while the app scrolls, a finger push forward (too slow) or pull back (too fast)
// corrects the speed of this song, based on how far behind or ahead the sheet was.
const L = { touching: false, autoPx: 0, movingSec: 0 };
function setupLearning() {
  const wrap = $('.sheetwrap');
  L.touching = false; L.autoPx = 0; L.movingSec = 0;
  let st0 = 0, a0 = 0, timer = 0, armed = false;
  const finish = () => {
    timer = 0; L.touching = false;
    if (!armed) return; armed = false;
    const d = (wrap.scrollTop - st0) - (L.autoPx - a0);
    const lineH = parseFloat($('#lines')?.style.fontSize || '18') * 1.3;
    const atEnd = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 2;
    if (Math.abs(d) < lineH || Math.abs(d) > wrap.clientHeight * 0.8 || atEnd && d > 0) { L.movingSec = Math.min(L.movingSec, 30); return; }
    const T = Math.min(90, Math.max(6, L.movingSec));
    const old = getSpeed();
    const ratio = Math.min(1.5, Math.max(0.67, 1 + 0.7 * (d / T) / (lineH * old / 60)));
    setSpeed(old * ratio);
    L.movingSec = 0;
    toast(`Scroll speed ${ratio > 1 ? 'up' : 'down'} to ${Math.round(getSpeed())} for this song`, 2000);
  };
  wrap.addEventListener('touchstart', () => {
    clearTimeout(timer); timer = 0;
    if (!L.touching) { st0 = wrap.scrollTop; a0 = L.autoPx; }
    L.touching = true;
    armed = S.listener.active && L.movingSec >= 3;
  }, { passive: true });
  const settle = () => { if (!L.touching) return; clearTimeout(timer); timer = setTimeout(finish, 350); };
  wrap.addEventListener('touchend', settle, { passive: true });
  wrap.addEventListener('touchcancel', settle, { passive: true });
  wrap.addEventListener('scroll', () => { if (timer) settle(); }, { passive: true });
}

function viewSong(id, setId, idx) {
  song = S.byId.get(id);
  if (!song) return go('#/');
  const set = setId ? S.setlists.find(x => x.id === setId) : null;
  ctx = { set, idx, version: song.versions.findIndex(v => v.main) };
  if (ctx.version < 0) ctx.version = 0;
  const app = $('#app');
  document.body.classList.add('insong');
  const multi = song.versions.length > 1;
  const sub = esc(songSub(song));
  app.innerHTML = topbar(btn('back', 'Back', 'data-act="back"'), esc(song.title), `
      ${multi ? btn('song_versions', 'Versions', 'id="ver"') : ''}
      <button class="ib fl-edit" id="score" aria-label="Change confidence">${flames(song.score)}</button>
      ${btn('add_to_setlist', 'Add to setlist', 'id="addset"')}
      ${btn('edit', 'More', 'id="more"')}`, sub) +
    `<main class="sheetwrap"><div id="sheet" class="sheet"></div></main>
    <footer class="bar">
      ${set ? btn('previous_song', 'Previous song', 'id="prev"' + (idx <= 0 ? ' disabled' : '')) : ''}
      <button class="ib listen" id="listen" aria-label="Listening on or off" aria-pressed="false">${icon('listening_off')}</button>
      <div class="meter" id="meter" title="Sound level"><div class="lvl" id="lvl"></div><div class="thr" id="thr"></div></div>
      ${btn('sound_sensitivity', 'Sensitivity', 'id="sens"')}
      ${btn('scroll_slower', 'Slower', 'id="slower"')}
      <div class="speed" id="speedv" aria-live="polite"></div>
      ${btn('scroll_faster', 'Faster', 'id="faster"')}
      ${btn('text_size', 'Text size', 'id="tsize"')}
      ${themeBtn()}
      ${set ? btn('next_song', 'Next song', 'id="next"' + (idx >= set.items.length - 1 ? ' disabled' : '')) : ''}
    </footer>`;
  drawSheet();
  keepAwake();
  if (S.listener.active) { const lb = $('#listen'); lb.innerHTML = icon('listening_on'); lb.classList.add('on'); lb.setAttribute('aria-pressed', 'true'); }
  if (song.capo) capoOverlay(song.capo);
  // controls
  showSpeed();
  $('#slower').onclick = () => nudgeSpeed(-SPEED_STEP);
  $('#faster').onclick = () => nudgeSpeed(SPEED_STEP);
  // foot pedal (or keyboard): left/up = slower, right/down = faster
  window.onkeydown = (e) => {
    if (document.querySelector('.modal')) return;
    if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) { e.preventDefault(); nudgeSpeed(-SPEED_STEP); }
    else if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(e.key)) { e.preventDefault(); nudgeSpeed(SPEED_STEP); }
  };
  setupLearning();
  $('#tsize').onclick = async () => {
    const steps = [0.8, 0.9, 1, 1.15, 1.3, 1.5];
    const v = await dialog(`<p class="q">Text size</p><div class="row wrap">${steps.map(s => `<button class="tb ${Math.abs(s - S.settings.textScale) < 0.01 ? 'primary' : ''}" data-v="${s}">${Math.round(s * 100)}%</button>`).join('')}</div><p class="hint">100% fits the longest chord line to the screen. Larger sizes scroll sideways, lines never break.</p>`);
    if (v) { S.settings.textScale = parseFloat(v); saveSettings(); drawSheet(); }
  };
  $('#listen').onclick = toggleListen;
  $('#sens').onclick = sensitivityDialog;
  $('#score').onclick = async () => {
    const v = await dialog(`<p class="q">Confidence for “${esc(song.title)}”</p><div class="row wrap">${[1, 2, 3, 4, 5].map(n => `<button class="tb ${n === song.score ? 'primary' : ''}" data-v="${n}">${flames(n)}</button>`).join('')}</div>`);
    if (v) { song.score = parseInt(v, 10); song.scoreSet = true; await db.putSong(song); markDirty(); $('#score').innerHTML = flames(song.score); }
  };
  $('#addset').onclick = () => addToSetlistDialog(song.id);
  $('#more').onclick = async () => {
    const v = await dialog(`<p class="q">${esc(song.title)}</p><p class="hint">Source: ${esc((song.source || []).join(', '))}</p><div class="col">
      <button class="tb" data-v="setlist">${icon('add_to_setlist', 'Add to setlist')}</button>
      <button class="tb" data-v="speed">${icon('start_auto_scroll', 'Reset scroll speed to default')}</button>
      <button class="tb danger" data-v="delete">${icon('delete', 'Delete this song')}</button>
      <button class="tb" data-v="">${icon('cancel', 'Close')}</button></div>`);
    if (v === 'setlist') addToSetlistDialog(song.id);
    if (v === 'speed') { delete S.speeds[song.id]; saveSpeeds(); markDirty(); showSpeed(); toast('Scroll speed reset to ' + S.settings.speed); }
    if (v === 'delete' && await confirmBox(`Are you sure? “${song.title}” will be removed from the app (your Word file stays).`)) {
      await db.deleteSong(song.id); S.songs = S.songs.filter(x => x.id !== song.id); S.byId.delete(song.id);
      S.setlists.forEach(sl => { sl.items = sl.items.filter(x => x !== song.id); }); await saveSetlists();
      toast('Song deleted'); go('#/');
    }
  };
  if (multi) $('#ver').onclick = async () => {
    const v = await dialog(`<p class="q">Version</p><div class="col">${song.versions.map((vv, i) => `<button class="tb ${i === ctx.version ? 'primary' : ''}" data-v="${i}">${esc(vv.label || 'Version ' + (i + 1))}${vv.main ? ' (main)' : ''}</button>`).join('')}</div>`);
    if (v !== null && v !== undefined && v !== '') { ctx.version = parseInt(v, 10); drawSheet(); }
  };
  if (set) {
    const goIdx = (i) => go(`#/song/${encodeURIComponent(set.items[i])}?set=${set.id}&i=${i}`);
    const p = $('#prev'), n = $('#next');
    if (p) p.onclick = () => idx > 0 && goIdx(idx - 1);
    if (n) n.onclick = () => idx < set.items.length - 1 && goIdx(idx + 1);
  }
  window.onresize = () => fitText();
  startLoop();
}
let charW100 = 60;
function measureFont() {
  const c = document.createElement('canvas').getContext('2d');
  c.font = '100px CampMono, "Courier New", monospace';
  charW100 = c.measureText('MMMMMMMMMM').width / 10;
}
function drawSheet() {
  const v = song.versions[ctx.version];
  const head = [];
  if (song.capo) head.push(`<div class="capoline">${icon('capo')}<span>CAPO ON ${song.capo}</span></div>`);
  if (song.type === 'own' && song.basedOn) head.push(`<div class="based">Based on: ${esc(song.basedOn.title)}${song.basedOn.artist ? ' - ' + esc(song.basedOn.artist) : ''}</div>`);
  for (const n of song.notes || []) head.push(`<div class="note">${icon('info_notes')}<span>${esc(n)}</span></div>`);
  if (song.versions.length > 1) head.push(`<div class="verlbl">${esc(v.label || '')}</div>`);
  $('#sheet').innerHTML = `<div class="head">${head.join('')}</div><div class="lines" id="lines">${v.lines.map(lineHTML).join('')}</div><div class="endpad"></div>`;
  fitText();
  $('#sheet').querySelectorAll('img[data-img]').forEach(async im => {
    const d = await db.getImage(im.dataset.img);
    if (d) im.src = `data:${d.mime};base64,${d.data}`;
  });
  $('.sheetwrap').scrollTop = 0;
}
function fitText() {
  const lines = $('#lines'); if (!lines) return;
  const v = song.versions[ctx.version];
  let maxLen = 20;
  for (const l of v.lines) if (l[0] !== 'i' && l[0] !== 'e' && !(l[0] === 't' && isProse(l[1]))) maxLen = Math.max(maxLen, l[1].length);
  const avail = $('.sheetwrap').clientWidth - 24;
  let px = avail / (maxLen * charW100 / 100);
  px = Math.max(10, Math.min(44, px)) * S.settings.textScale;
  lines.style.fontSize = px.toFixed(2) + 'px';
  lines.style.setProperty('--imgw', Math.round(100 * S.settings.textScale) + '%');
  $('#sheet').style.setProperty('--fs', px.toFixed(2) + 'px');
}
function capoOverlay(n) {
  const o = document.createElement('div'); o.className = 'capoov'; o.setAttribute('role', 'alert');
  o.innerHTML = `<div class="capoic">${ICONS.capo}</div><div class="capotx">CAPO ON ${n}</div>`;
  document.body.appendChild(o);
  const kill = () => { o.classList.add('out'); setTimeout(() => o.remove(), 350); };
  o.onclick = kill; setTimeout(kill, 3000);
}
async function toggleListen() {
  const b = $('#listen');
  if (S.listener.active) { S.listener.stop(); b.innerHTML = icon('listening_off'); b.setAttribute('aria-pressed', 'false'); b.classList.remove('on'); return; }
  try {
    await S.listener.start();
    b.innerHTML = icon('listening_on'); b.setAttribute('aria-pressed', 'true'); b.classList.add('on');
    S.lastLoud = 0;
  } catch (e) { toast('Microphone not available. Allow microphone access for this app in Chrome.'); }
}
function startLoop() {
  let last = performance.now(), acc = 0;
  const wrap = $('.sheetwrap');
  const step = (now) => {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    const lvl = S.listener.active ? S.listener.read() : 0;
    const lv = $('#lvl'), th = $('#thr');
    if (lv) { lv.style.width = lvl.toFixed(0) + '%'; th.style.left = S.settings.threshold + '%'; lv.classList.toggle('hot', lvl >= S.settings.threshold); }
    if (S.listener.active) {
      if (lvl >= S.settings.threshold) S.lastLoud = now;
      const moving = S.lastLoud && now - S.lastLoud <= S.settings.hangover * 1000;
      document.body.classList.toggle('scrolling', !!moving);
      if (moving && wrap && !L.touching) {
        const fs = parseFloat($('#lines')?.style.fontSize || '18');
        const pxPerSec = fs * 1.3 * getSpeed() / 60;
        L.movingSec += dt;
        acc += pxPerSec * dt;
        if (acc >= 1) { const whole = Math.floor(acc); const before = wrap.scrollTop; wrap.scrollTop += whole; L.autoPx += wrap.scrollTop - before; acc -= whole; }
      }
    } else document.body.classList.remove('scrolling');
    S.raf = requestAnimationFrame(step);
  };
  S.raf = requestAnimationFrame(step);
}
async function sensitivityDialog() {
  await dialog(`<p class="q">Listening</p>
    <label class="fld">Minimum loudness to keep scrolling <b id="tv">${S.settings.threshold}</b><input type="range" id="th" min="0" max="100" value="${S.settings.threshold}"></label>
    <div class="meter big"><div class="lvl" id="lvl2"></div><div class="thr" id="thr2"></div></div>
    <p class="hint">Play and sing: the bar must cross the line. Background chatter must stay below it.</p>
    <label class="fld">Keep scrolling after a pause <b id="hv">${S.settings.hangover.toFixed(1)} s</b><input type="range" id="hg" min="0.3" max="5" step="0.1" value="${S.settings.hangover}"></label>
    <div class="row end"><button class="tb primary" data-v="ok">${icon('confirm', 'Done')}</button></div>`, {
    onOpen: (w) => {
      const th = $('#th', w), hg = $('#hg', w);
      th.oninput = () => { S.settings.threshold = +th.value; $('#tv', w).textContent = th.value; saveSettings(); };
      hg.oninput = () => { S.settings.hangover = +hg.value; $('#hv', w).textContent = (+hg.value).toFixed(1) + ' s'; saveSettings(); };
      const tick = () => { if (!document.body.contains(w)) return; const l = S.listener.active ? S.listener.level : 0; $('#lvl2', w).style.width = l.toFixed(0) + '%'; $('#thr2', w).style.left = S.settings.threshold + '%'; requestAnimationFrame(tick); };
      tick();
    },
  });
}

// ---------- setlists ----------
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
async function addToSetlistDialog(songId) {
  const v = await dialog(`<p class="q">Add to setlist</p><div class="col">${S.setlists.map(sl => `<button class="tb" data-v="${sl.id}">${icon('setlists', sl.name + (sl.items.includes(songId) ? ' ✓' : ''))}</button>`).join('')}<button class="tb primary" data-v="__new">${icon('add_to_setlist', 'New setlist')}</button></div>`);
  if (!v) return;
  let sl;
  if (v === '__new') { const name = await promptBox('Name of the new setlist'); if (!name) return; sl = { id: uid(), name, items: [] }; S.setlists.push(sl); }
  else sl = S.setlists.find(x => x.id === v);
  if (!sl.items.includes(songId)) sl.items.push(songId);
  await saveSetlists(); toast(`Added to “${sl.name}”`);
}
function viewSetlists() {
  const app = $('#app');
  app.innerHTML = topbar(btn('back', 'Back', 'data-act="home"'), 'Setlists', `${btn('add_to_setlist', 'New setlist', 'id="newsl"')}${themeBtn()}`) +
    `<main class="lib"><ul class="songs">${S.setlists.map(sl => `<li><a class="song" href="#/setlist/${sl.id}"><div class="st"><div class="t1">${esc(sl.name)}</div><div class="t2">${sl.items.length} song${sl.items.length === 1 ? '' : 's'}</div></div><span class="ic">${ICONS.setlists}</span></a></li>`).join('') || '<li class="emptyl">No setlists yet. Tap the + button to make one, e.g. “Campfire”.</li>'}</ul></main>`;
  $('#newsl').onclick = async () => { const name = await promptBox('Name of the new setlist'); if (!name) return; const sl = { id: uid(), name, items: [] }; S.setlists.push(sl); await saveSetlists(); go('#/setlist/' + sl.id); };
}
function viewSetlist(id) {
  const sl = S.setlists.find(x => x.id === id); if (!sl) return go('#/setlists');
  const app = $('#app');
  app.innerHTML = topbar(btn('back', 'Back', 'data-act="setlists"'), esc(sl.name), `${btn('edit', 'Rename', 'id="ren"')}${btn('delete', 'Delete setlist', 'id="del"')}`, `${sl.items.length} songs`) +
    `<main class="lib"><button class="tb primary wide" id="addsongs">${icon('add_to_setlist', 'Add songs')}</button>
     <ul class="songs drag" id="sl">${sl.items.map((sid, i) => { const s = S.byId.get(sid); if (!s) return ''; return `<li data-i="${i}"><span class="handle" aria-label="Drag to reorder">≡</span><a class="song" href="#/song/${encodeURIComponent(sid)}?set=${sl.id}&i=${i}"><div class="st"><div class="t1">${i + 1}. ${esc(s.title)}</div><div class="t2">${esc(songSub(s))}</div></div>${s.capo ? `<span class="capob">${icon('capo')}${s.capo}</span>` : ''}</a><button class="ib rm" data-rm="${i}" aria-label="Remove from setlist">${icon('cancel')}</button></li>`; }).join('')}</ul></main>`;
  $('#ren').onclick = async () => { const n = await promptBox('New name', sl.name); if (n) { sl.name = n; await saveSetlists(); viewSetlist(id); } };
  $('#del').onclick = async () => { if (await confirmBox(`Are you sure you want to delete the setlist “${sl.name}”? The songs stay in the app.`)) { S.setlists = S.setlists.filter(x => x !== sl); await saveSetlists(); go('#/setlists'); } };
  app.querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => { sl.items.splice(+b.dataset.rm, 1); await saveSetlists(); viewSetlist(id); });
  $('#addsongs').onclick = () => songPicker(sl);
  enableDrag($('#sl'), async (from, to) => { const [x] = sl.items.splice(from, 1); sl.items.splice(to, 0, x); await saveSetlists(); viewSetlist(id); });
}
function enableDrag(ul, onMove) {
  let dragEl = null, startY = 0, fromIdx = -1;
  ul.querySelectorAll('.handle').forEach(h => {
    h.addEventListener('pointerdown', e => {
      e.preventDefault();
      dragEl = h.closest('li'); fromIdx = +dragEl.dataset.i; startY = e.clientY;
      dragEl.classList.add('dragging'); h.setPointerCapture(e.pointerId);
    });
    h.addEventListener('pointermove', e => { if (dragEl) dragEl.style.transform = `translateY(${e.clientY - startY}px)`; });
    const end = e => {
      if (!dragEl) return;
      const y = e.clientY;
      const others = [...ul.children].filter(li => li !== dragEl);
      let to = others.filter(li => { const r = li.getBoundingClientRect(); return r.top + r.height / 2 < y; }).length;
      dragEl.style.transform = ''; dragEl.classList.remove('dragging'); dragEl = null;
      if (to !== fromIdx) onMove(fromIdx, to);
    };
    h.addEventListener('pointerup', end);
    h.addEventListener('pointercancel', end);
  });
}
async function songPicker(sl) {
  await dialog(`<p class="q">Add songs to “${esc(sl.name)}”</p><div class="searchrow"><span class="ic">${ICONS.search}</span><input id="pq" type="search" placeholder="Search"></div><ul class="songs pick" id="pl"></ul><div class="row end"><button class="tb primary" data-v="ok">${icon('confirm', 'Done')}</button></div>`, {
    onOpen: (w) => {
      const draw = () => {
        const q = $('#pq', w).value.toLowerCase();
        const list = S.songs.filter(s => !q || (s.title + ' ' + s.artist).toLowerCase().includes(q)).sort((a, b) => a.title.localeCompare(b.title, 'nl')).slice(0, 80);
        $('#pl', w).innerHTML = list.map(s => `<li><button class="song pickb ${sl.items.includes(s.id) ? 'on' : ''}" data-id="${esc(s.id)}"><div class="st"><div class="t1">${esc(s.title)}</div><div class="t2">${esc(songSub(s))}</div></div><span class="ic">${sl.items.includes(s.id) ? ICONS.confirm : ICONS.add_to_setlist}</span></button></li>`).join('');
        w.querySelectorAll('.pickb').forEach(b => b.onclick = async (e) => { e.stopPropagation(); const sid = b.dataset.id; if (!sl.items.includes(sid)) sl.items.push(sid); else sl.items = sl.items.filter(x => x !== sid); await saveSetlists(); draw(); });
      };
      $('#pq', w).oninput = draw; draw();
    },
  });
  viewSetlist(sl.id);
}

// ---------- chord dictionary ----------
function viewChords() {
  const map = new Map();
  for (const s of S.songs) for (const d of s.chordDefs || []) {
    if (!map.has(d.name)) map.set(d.name, new Map());
    const m = map.get(d.name); if (!m.has(d.fing)) m.set(d.fing, []); m.get(d.fing).push(s);
  }
  const names = [...map.keys()].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }) || a.localeCompare(b));
  const col = getComputedStyle(document.documentElement).getPropertyValue('--chord').trim();
  const app = $('#app');
  app.innerHTML = topbar(btn('back', 'Back', 'data-act="home"'), 'Chords', themeBtn(), `${names.length} chords from your sheets`) +
    `<main class="lib"><div class="searchrow"><span class="ic">${ICONS.search}</span><input id="cq" type="search" placeholder="Search chord, e.g. G or Cadd9"></div><div id="cl"></div></main>`;
  const draw = () => {
    const q = $('#cq').value.trim().toLowerCase();
    $('#cl').innerHTML = names.filter(n => !q || n.toLowerCase().startsWith(q)).map(n => `<section class="chord"><h3>${esc(n)}</h3>${[...map.get(n)].map(([f, songs]) => `<div class="var"><div class="fing">${esc(n)} = ${esc(f)}</div>${needsDiagram(n) ? `<div class="dia">${diagramSVG(f, col)}</div>` : ''}<div class="in">${songs.map(s => `<a class="pill" href="#/song/${encodeURIComponent(s.id)}">${esc(s.title)}</a>`).join('')}</div></div>`).join('')}</section>`).join('');
  };
  $('#cq').oninput = draw; draw();
}

// ---------- settings, import, backup ----------
function viewSettings() {
  const app = $('#app');
  const own = S.songs.filter(s => s.type === 'own').length;
  app.innerHTML = topbar(btn('back', 'Back', 'data-act="home"'), 'Settings', themeBtn()) + `<main class="lib set">
    <section><h3>${icon('sound_sensitivity', 'Listening and scrolling')}</h3>
      <button class="tb" id="mic">${icon(S.listener.active ? 'listening_on' : 'listening_off', S.listener.active ? 'Stop test' : 'Test microphone')}</button>
      <div class="meter big"><div class="lvl" id="lvl"></div><div class="thr" id="thr"></div></div>
      <label class="fld">Minimum loudness to keep scrolling <b id="tv">${S.settings.threshold}</b><input type="range" id="th" min="0" max="100" value="${S.settings.threshold}"></label>
      <label class="fld">Keep scrolling after a pause <b id="hv">${S.settings.hangover.toFixed(1)} s</b><input type="range" id="hg" min="0.3" max="5" step="0.1" value="${S.settings.hangover}"></label>
      <label class="fld">Default scroll speed (lines per minute) <b id="sv">${S.settings.speed}</b><input type="range" id="sp" min="2" max="40" value="${S.settings.speed}"></label>
    </section>
    <section><h3>${icon('import_song', 'Import')}</h3>
      <p class="hint">Choose one or more new or updated <b>.docx</b> files (Google Drive appears in the file picker), or <b>campfire-data.json</b>. Your confidence scores in the app are always kept.</p>
      <label class="tb primary">${icon('import_song', 'Import songs')}<input type="file" id="imp" accept=".docx,.doc,.json,application/json,application/vnd.openxmlformats-officedocument.wordprocessingml.document" multiple hidden></label>
    </section>
    <section><h3>${icon('backup_export', 'Backup')}</h3>
      <p class="hint">One file with all songs, scores, setlists and settings. Keep it in your Drive folder.${S.settings.lastBackup ? ' Last backup: ' + new Date(S.settings.lastBackup).toLocaleDateString('en-GB') + '.' : ' No backup made yet.'}</p>
      <div class="row wrap"><button class="tb primary" id="bk">${icon('backup_export', 'Make backup')}</button>
      <label class="tb">${icon('restore_backup', 'Restore backup')}<input type="file" id="rs" accept=".json,application/json" hidden></label></div>
    </section>
    <section><h3>${icon('flame', 'Confidence scores')}</h3>
      <p class="hint">List of songs whose score in the app differs from the number in the file name, so you can rename your files.</p>
      <button class="tb" id="scx">${icon('backup_export', 'Export score changes')}</button>
    </section>
    <section><h3>${icon('info_notes', 'About')}</h3>
      <p class="hint">${S.songs.length} songs (${own} My Own Creations), ${S.setlists.length} setlists. <span id="pers"></span> Everything stays on this tablet. Version ${APP_VERSION}.</p>
    </section></main>`;
  const th = $('#th'), hg = $('#hg'), sp = $('#sp');
  th.oninput = () => { S.settings.threshold = +th.value; $('#tv').textContent = th.value; saveSettings(); };
  hg.oninput = () => { S.settings.hangover = +hg.value; $('#hv').textContent = (+hg.value).toFixed(1) + ' s'; saveSettings(); };
  sp.oninput = () => { S.settings.speed = +sp.value; $('#sv').textContent = sp.value; saveSettings(); };
  $('#mic').onclick = async () => { if (S.listener.active) S.listener.stop(); else { try { await S.listener.start(); } catch (e) { toast('Microphone not available.'); } } viewSettings(); };
  const tick = () => { const lv = $('#lvl'); if (!lv || !location.hash.startsWith('#/settings')) { if (!location.hash.startsWith('#/song')) S.listener.stop(); return; } const l = S.listener.active ? S.listener.read() : 0; lv.style.width = l.toFixed(0) + '%'; lv.classList.toggle('hot', l >= S.settings.threshold); $('#thr').style.left = S.settings.threshold + '%'; requestAnimationFrame(tick); };
  tick();
  $('#imp').onchange = (e) => importFiles([...e.target.files]);
  $('#bk').onclick = exportBackup;
  $('#rs').onchange = (e) => restoreBackup(e.target.files[0]);
  $('#scx').onclick = exportScoreChanges;
  if (navigator.storage?.persisted) navigator.storage.persisted().then(p => { const el = $('#pers'); if (el) el.textContent = p ? 'Storage is protected against automatic clean-up.' : 'Storage is not yet protected; it will be requested at the next import.'; });
}

function fileScoreOf(s) { const m = (s.source?.[0] || '').match(/^(\d)/); return m ? parseInt(m[1], 10) : null; }
async function importFiles(files) {
  if (!files.length) return;
  const busy = document.createElement('div'); busy.className = 'busy'; busy.innerHTML = '<div class="spin"></div><p>Importing…</p>'; document.body.appendChild(busy);
  const report = [];
  try {
    for (const f of files) {
      const name = f.name.toLowerCase();
      if (name.startsWith('~$')) continue;
      if (name.endsWith('.doc')) { report.push(`${f.name}: please open it in Word and save it as .docx, then import again.`); continue; }
      if (name.endsWith('.json')) {
        const data = JSON.parse(await f.text());
        if (data.type === 'backup') { busy.remove(); return restoreBackup(f, data); }
        if (!Array.isArray(data.songs)) { report.push(`${f.name}: not a Campfire data file.`); continue; }
        if (data.images) await db.putImages(data.images);
        let added = 0, updated = 0;
        const byKey = new Map(S.songs.map(s => [s.nameKey, s]));
        const out = [];
        for (const s of data.songs) {
          s.nameKey = nameKey(s.source[0]);
          s.fileScore = fileScoreOf(s);
          const ex = byKey.get(s.nameKey) || S.byId.get(s.id);
          if (ex) { s.id = ex.id; if (ex.scoreSet) { s.score = ex.score; s.scoreSet = true; } updated++; } else added++;
          out.push(s);
        }
        await db.putSongs(out);
        report.push(`${f.name}: ${added} songs added, ${updated} updated.`);
        continue;
      }
      if (name.endsWith('.docx')) {
        const { song: s, images, stats } = await importDocx(f);
        await db.putImages(images);
        const ex = S.songs.find(x => x.nameKey === s.nameKey);
        if (ex) {
          // keep everything curated in the app; only the sheet itself is replaced
          s.id = ex.id; s.title = ex.title; s.artist = ex.artist; s.type = ex.type; s.basedOn = ex.basedOn;
          if (ex.scoreSet || ex.type === 'own') { s.score = ex.score; s.scoreSet = ex.scoreSet; }
          if (s.capo == null) s.capo = ex.capo;
          for (const d of ex.chordDefs || []) if (!s.chordDefs.some(x => x.name === d.name)) s.chordDefs.push(d);
          for (const n of ex.notes || []) if (!s.notes.includes(n)) s.notes.push(n);
          if ((ex.source || []).length > 1) { s.versions = [...s.versions, ...ex.versions.filter(v => !v.main)]; s.source = [...new Set([...s.source, ...ex.source])]; }
        } else s.id = s.nameKey + '-' + Date.now().toString(36);
        await db.putSong(s);
        report.push(`${s.title}: ${ex ? 'updated' : 'added'}. ${stats.pairs} chord lines aligned${stats.half ? `, ${stats.half} chords exactly between two letters (placed on the right one)` : ''}${stats.collision ? `, ${stats.collision} chord lines kept as typed` : ''}.`);
        continue;
      }
      report.push(`${f.name}: unknown file type.`);
    }
    if (!S.settings.firstUse) S.settings.firstUse = Date.now();
    markDirty();
    if (navigator.storage?.persist) await navigator.storage.persist();
  } catch (e) { report.push('Import failed: ' + e.message); }
  busy.remove();
  await load();
  await dialog(`<p class="q">Import finished</p><ul class="rep">${report.map(r => `<li>${esc(r)}</li>`).join('')}</ul><div class="row end"><button class="tb primary" data-v="ok">${icon('confirm', 'OK')}</button></div>`);
  route();
}
async function download(name, text, mime = 'application/json') {
  const blob = new Blob([text], { type: mime });
  const file = new File([blob], name, { type: mime });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return true; } catch (e) { if (e.name === 'AbortError') return false; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  return true;
}
async function exportBackup() {
  const data = { app: "Erik's Campfire Music", type: 'backup', format: 1, created: new Date().toISOString(), songs: await db.allSongs(), images: await db.allImages(), setlists: S.setlists, speeds: S.speeds, settings: { ...S.settings } };
  const d = new Date(); const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (await download(`campfire-backup-${stamp}.json`, JSON.stringify(data))) {
    S.settings.lastBackup = Date.now(); S.settings.dirty = false; saveSettings(); toast('Backup made. Keep it in your Drive folder.'); route();
  }
}
async function restoreBackup(file, parsed) {
  if (!file) return;
  const data = parsed || JSON.parse(await file.text());
  if (data.type !== 'backup') { toast('This is not a backup file.'); return; }
  if (!await confirmBox(`Restore the backup of ${new Date(data.created).toLocaleString('en-GB')}? This replaces all songs, scores, setlists and settings on this tablet.`, 'Restore')) return;
  await db.clearAll();
  await db.putImages(data.images || {});
  await db.putSongs(data.songs || []);
  await db.setMeta('setlists', data.setlists || []);
  await db.setMeta('speeds', data.speeds || {});
  await db.setMeta('settings', { ...data.settings, lastBackup: Date.now(), dirty: false });
  await load(); toast('Backup restored'); go('#/');
}
async function exportScoreChanges() {
  const rows = S.songs.filter(s => s.type !== 'own' && s.fileScore && s.score !== s.fileScore).sort((a, b) => a.title.localeCompare(b.title));
  if (!rows.length) { toast('All scores match your file names.'); return; }
  const txt = "Erik's Campfire Music: confidence scores that differ from the file name\r\n\r\n" + rows.map(s => `${s.source[0]}\r\n   -> ${s.score}${s.source[0].replace(/^\d/, '')}`).join('\r\n\r\n') + '\r\n';
  download('score-changes.txt', txt, 'text/plain');
}

// ---------- start ----------
async function start() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try { await document.fonts.load('20px CampMono'); } catch (e) { /* ignore */ }
  measureFont();
  await load();
  const sp = $('#splash');
  setTimeout(() => { sp.classList.add('out'); setTimeout(() => sp.remove(), 600); }, 1800);
  route();
}
start();
