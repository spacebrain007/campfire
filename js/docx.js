// .docx import: unzip, lay out every character like Word does, and write monospace lines
// with chords placed above the right letters. Port of the conversion used for the first import.
import { METRICS } from './metrics.js';
import { classify, isChord, chordName, xchord, FILLER, LABEL_RE, sentence, normArtist, parseFilename, parseCapo, parseDefs } from './chords.js';

// ---------- zip ----------
async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
export async function unzip(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a .docx (zip) file');
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = {};
  const dec = new TextDecoder();
  for (let k = 0; k < n; k++) {
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nl));
    const lnl = dv.getUint16(off + 26, true), lel = dv.getUint16(off + 28, true);
    const data = u8.subarray(off + 30 + lnl + lel, off + 30 + lnl + lel + csize);
    files[name] = { method, data };
    p += 46 + nl + el + cl;
  }
  return {
    has: (name) => name in files,
    names: () => Object.keys(files),
    async bytes(name) { const f = files[name]; if (!f) return null; return f.method === 0 ? f.data : await inflateRaw(f.data); },
    async text(name) { const b = await this.bytes(name); return b ? dec.decode(b) : null; },
  };
}

// ---------- metrics ----------
const CHARIDX = new Map([...METRICS.chars].map((c, i) => [c, i]));
const MONO = new Set(['courier new', 'couriernewpsmt', 'couriernewps-boldmt', 'courier', 'liberation mono']);
const FMAP = { 'times new roman': ['serif', 'serifb'], 'liberation serif': ['serif', 'serifb'], 'arial': ['sans', 'sansb'], 'liberation sans': ['sans', 'sansb'],
  'calibri': ['carlito', 'carlitob'], 'aptos': ['carlito', 'carlitob'], 'cambria': ['caladea', 'caladeab'], 'cambria math': ['caladea', 'caladeab'],
  'arial black': ['sansb', 'sansb'], 'aptos black': ['sansb', 'sansb'], 'arial narrow': ['sans', 'sansb'], 'verdana': ['dejavu', 'dejavub'], 'tahoma': ['dejavu', 'dejavub'] };
const SCALE = { 'arial narrow': 0.82, 'arial black': 1.12 };
const MONO_EM = 1229 / 2048;
function charWidth(ch, font, sz, bold) {
  const key = (font || 'courier new').toLowerCase();
  if (MONO.has(key)) return MONO_EM * (sz / 2) * 20;
  const t = FMAP[key] || ['sans', 'sansb'];
  const f = bold ? t[1] : t[0];
  const i = CHARIDX.get(ch);
  const adv = i === undefined ? -1 : METRICS.w[f][i];
  const em = adv < 0 ? 0.6 : adv / METRICS.upm[f];
  return em * (sz / 2) * 20 * (SCALE[key] || 1);
}
const cwOf = (sz) => MONO_EM * (sz / 2) * 20;
// Python-style rounding (half to even), identical to the first conversion
function pyRound(v) { const f = Math.floor(v), d = v - f; if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1; return Math.round(v); }

// ---------- XML helpers ----------
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const kids = (el, name) => el ? [...el.children].filter(c => c.localName === name && c.namespaceURI === W) : [];
const kid = (el, name) => kids(el, name)[0] || null;
const wa = (el, name) => el ? el.getAttributeNS(W, name) ?? el.getAttribute('w:' + name) : null;
const ival = (v, d = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

class Doc {
  constructor(zip, docXml, stylesXml, settingsXml, themeXml, relsXml) {
    const P = new DOMParser();
    this.doc = P.parseFromString(docXml, 'application/xml');
    this.theme = { minor: 'Calibri', major: 'Calibri Light' };
    if (themeXml) {
      const mi = themeXml.match(/<a:minorFont><a:latin typeface="([^"]*)"/); if (mi) this.theme.minor = mi[1];
      const ma = themeXml.match(/<a:majorFont><a:latin typeface="([^"]*)"/); if (ma) this.theme.major = ma[1];
    }
    this.deftab = 720;
    if (settingsXml) { const m = settingsXml.match(/<w:defaultTabStop w:val="(\d+)"/); if (m) this.deftab = parseInt(m[1], 10) || 720; }
    this.rels = {};
    if (relsXml) for (const m of relsXml.matchAll(/<Relationship [^>]*?Id="([^"]+)"[^>]*?Target="([^"]+)"/g)) this.rels[m[1]] = m[2];
    if (relsXml) for (const m of relsXml.matchAll(/<Relationship [^>]*?Target="([^"]+)"[^>]*?Id="([^"]+)"/g)) this.rels[m[2]] = m[1];
    this.styles = {}; this.defR = { font: 'Times New Roman', sz: 20, b: false }; this.defP = {}; this.defaultPStyle = null;
    if (stylesXml) {
      const st = P.parseFromString(stylesXml, 'application/xml').documentElement;
      const dd = kid(st, 'docDefaults');
      if (dd) {
        const rp = kid(kid(dd, 'rPrDefault'), 'rPr');
        Object.entries(this.rpr(rp)).forEach(([k, v]) => { if (v !== null) this.defR[k] = v; });
        this.defP = this.ppr(kid(kid(dd, 'pPrDefault'), 'pPr'));
      }
      for (const s of kids(st, 'style')) {
        const sid = wa(s, 'styleId');
        this.styles[sid] = { type: wa(s, 'type'), based: wa(kid(s, 'basedOn'), 'val'), r: this.rpr(kid(s, 'rPr')), p: this.ppr(kid(s, 'pPr')) };
        if (wa(s, 'type') === 'paragraph' && wa(s, 'default') === '1') this.defaultPStyle = sid;
      }
    }
  }
  rpr(r) {
    const d = { font: null, sz: null, b: null };
    if (!r) return d;
    const f = kid(r, 'rFonts');
    if (f) {
      const v = wa(f, 'ascii') || wa(f, 'hAnsi');
      if (v) d.font = v;
      else { const th = wa(f, 'asciiTheme') || wa(f, 'hAnsiTheme'); if (th) d.font = th.includes('minor') ? this.theme.minor : this.theme.major; }
    }
    const sz = kid(r, 'sz'); if (sz) d.sz = ival(wa(sz, 'val'), null);
    const b = kid(r, 'b'); if (b) d.b = !['0', 'false'].includes(wa(b, 'val'));
    return d;
  }
  ppr(p) {
    const d = {};
    if (!p) return d;
    const t = kid(p, 'tabs'); if (t) d.tabs = kids(t, 'tab').map(x => [wa(x, 'val'), ival(wa(x, 'pos'))]);
    const i = kid(p, 'ind');
    if (i) { d.ind = {}; for (const k of ['left', 'start', 'hanging', 'firstLine']) { const v = wa(i, k); if (v !== null && v !== '') d.ind[k] = ival(v); } }
    const j = kid(p, 'jc'); if (j) d.jc = wa(j, 'val');
    return d;
  }
  chain(sid) { const out = []; const seen = new Set(); while (sid && this.styles[sid] && !seen.has(sid)) { seen.add(sid); out.push(this.styles[sid]); sid = this.styles[sid].based; } return out; }
  paraProps(p) {
    const ppr = kid(p, 'pPr');
    const ps = ppr ? kid(ppr, 'pStyle') : null;
    const sid = ps ? wa(ps, 'val') : this.defaultPStyle;
    const ch = this.chain(sid);
    const tabs = new Map(); let ind = {}; let jc = null;
    const layers = [this.defP, ...ch.slice().reverse().map(c => c.p), this.ppr(ppr)];
    for (const L of layers) {
      for (const [val, pos] of (L.tabs || [])) { if (val === 'clear') tabs.delete(pos); else tabs.set(pos, val); }
      if (L.ind) ind = { ...ind, ...L.ind };
      if (L.jc) jc = L.jc;
    }
    const r = { ...this.defR };
    for (const c of ch.slice().reverse()) for (const [k, v] of Object.entries(c.r)) if (v !== null) r[k] = v;
    return { tabs, ind, jc, r };
  }
  runProps(run, base) {
    const d = { ...base };
    const rpr = kid(run, 'rPr');
    if (rpr) {
      const rs = kid(rpr, 'rStyle');
      if (rs) for (const c of this.chain(wa(rs, 'val')).reverse()) for (const [k, v] of Object.entries(c.r)) if (v !== null) d[k] = v;
      for (const [k, v] of Object.entries(this.rpr(rpr))) if (v !== null) d[k] = v;
    }
    return d;
  }
}

const WING = { F0E0: '→', F0E8: '→', F0D8: '→', F0F0: '⇒', F0E7: '←', F0DF: '←', F0FC: '✓', F0A7: '▪', F0B7: '•' };
const SPACEMAP = { ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', '​': '' };
function* iterRuns(el) {
  for (const c of el.children) {
    const n = c.localName;
    if (n === 'r' && c.namespaceURI === W) yield c;
    else if (['hyperlink', 'ins', 'smartTag', 'fldSimple', 'customXml', 'sdt', 'sdtContent', 'bdo', 'dir'].includes(n)) yield* iterRuns(c);
    else if (n === 'AlternateContent') { const ch = [...c.children].find(x => x.localName === 'Choice'); if (ch) yield* iterRuns(ch); }
  }
}
function paraItems(doc, p, props) {
  const items = [];
  for (const r of iterRuns(p)) {
    const rp = doc.runProps(r, props.r);
    const font = rp.font || 'Times New Roman', sz = rp.sz || 20, b = !!rp.b;
    for (const ch of r.children) {
      const n = ch.localName;
      if (n === 't') { for (let c of ch.textContent) { c = SPACEMAP[c] ?? c; if (c) items.push({ t: 'c', c, font, sz, b }); } }
      else if (n === 'tab') items.push({ t: 't', font, sz });
      else if (n === 'br' || n === 'cr') items.push({ t: 'n' });
      else if (n === 'noBreakHyphen') items.push({ t: 'c', c: '-', font, sz, b });
      else if (n === 'sym') items.push({ t: 'c', c: WING[(wa(ch, 'char') || '').toUpperCase()] || '→', font: 'courier new', sz, b });
      else if (n === 'drawing' || n === 'pict' || n === 'AlternateContent') {
        for (const bl of ch.getElementsByTagNameNS('*', 'blip')) { const id = bl.getAttribute('r:embed') || bl.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed'); if (id && doc.rels[id]) items.push({ t: 'img', target: doc.rels[id] }); }
        for (const im of ch.getElementsByTagNameNS('*', 'imagedata')) { const id = im.getAttribute('r:id'); if (id && doc.rels[id]) items.push({ t: 'img', target: doc.rels[id] }); }
      }
    }
  }
  return items;
}
function layoutPara(doc, p, colwidth) {
  const props = doc.paraProps(p);
  const items = paraItems(doc, p, props);
  const ind = props.ind;
  const left = ind.left ?? ind.start ?? 0;
  const first = (ind.firstLine || 0) - (ind.hanging || 0);
  const stops = [...props.tabs.entries()].filter(([, v]) => v !== 'clear' && v !== 'bar').map(([k]) => k).sort((a, b) => a - b);
  const lines = [];
  let cur = { chars: [], imgs: [], x0: left + first };
  let x = left + first;
  for (const it of items) {
    if (it.t === 'n') { lines.push(cur); cur = { chars: [], imgs: [], x0: left }; x = left; continue; }
    if (it.t === 'img') { cur.imgs.push(it.target); continue; }
    if (it.t === 't') {
      let nxt = stops.find(s => s > x + 1);
      if (nxt === undefined) { nxt = (Math.floor((x + 1) / doc.deftab) + 1) * doc.deftab; if (nxt <= x) nxt += doc.deftab; }
      if (ind.hanging && left > x + 1 && left < nxt) nxt = left;
      if (nxt > colwidth + 20 && cur.chars.length) { lines.push(cur); cur = { chars: [], imgs: [], x0: left, wrapped: true }; x = left; continue; }
      cur.chars.push({ c: '\t', x, x2: nxt, font: it.font, sz: it.sz });
      x = nxt; continue;
    }
    const w = charWidth(it.c, it.font, it.sz, it.b);
    cur.chars.push({ c: it.c, x, x2: x + w, font: it.font, sz: it.sz });
    x += w;
  }
  lines.push(cur);
  for (const L of lines) {
    L.jc = props.jc;
    if ((props.jc === 'center' || props.jc === 'right') && L.chars.length) {
      const width = L.chars[L.chars.length - 1].x2 - L.x0;
      const shift = (colwidth - left - width) / (props.jc === 'center' ? 2 : 1);
      for (const c of L.chars) { c.x += shift; c.x2 += shift; }
    }
  }
  return lines;
}
function walkBody(doc, el, colwidth, out) {
  for (const ch of el.children) {
    const n = ch.localName;
    if (n === 'p') out.push(...layoutPara(doc, ch, colwidth));
    else if (n === 'tbl') {
      for (const tr of kids(ch, 'tr')) {
        const cells = kids(tr, 'tc');
        const single = cells.every(c => kids(c, 'p').length === 1);
        if (single && cells.length > 1) {
          const merged = { chars: [], imgs: [], x0: 0, tableRow: true };
          let off = 0;
          for (const c of cells) {
            const tcw = kid(kid(c, 'tcPr'), 'tcW');
            const cw = tcw ? ival(wa(tcw, 'w'), 1500) : 1500;
            const L = layoutPara(doc, kid(c, 'p'), cw)[0];
            const x0 = L.chars.length ? L.chars[0].x : 0;
            for (const c2 of L.chars) merged.chars.push({ ...c2, x: c2.x - x0 + off + 100, x2: c2.x2 - x0 + off + 100 });
            merged.imgs.push(...L.imgs);
            off += cw;
          }
          out.push(merged);
        } else for (const c of cells) walkBody(doc, c, colwidth, out);
      }
    } else if (['sdt', 'sdtContent', 'customXml'].includes(n)) walkBody(doc, ch, colwidth, out);
  }
}

// ---------- monospace rendering ----------
const lineText = (L) => L.chars.map(c => c.c).join('');
const monoLine = (L) => L.chars.length > 0 && L.chars.every(c => c.c === '\t' || MONO.has(c.font.toLowerCase()));
function domSize(L) {
  const cnt = new Map();
  for (const c of L.chars) if (c.c.trim()) cnt.set(c.sz, (cnt.get(c.sz) || 0) + 1);
  let best = 20, bn = -1; for (const [k, v] of cnt) if (v > bn) { best = k; bn = v; }
  return best;
}
function renderGeneric(L, cwRef, base) {
  const chars = L.chars;
  if (!chars.length) return { s: '', cols: [], cw: cwRef };
  const cw = monoLine(L) ? cwOf(domSize(L)) : cwRef;
  const cols = []; let out = '';
  let pos = Math.max(0, pyRound((chars[0].x - base) / cw));
  out = ' '.repeat(pos);
  for (const c of chars) {
    if (c.c === '\t') { const target = pyRound((c.x2 - base) / cw); cols.push(pos); if (target > pos) { out += ' '.repeat(target - pos); pos = target; } continue; }
    cols.push(pos); out += c.c; pos++;
  }
  return { s: out, cols, cw };
}
function tokens(L) {
  const toks = []; let cur = null;
  L.chars.forEach((c, i) => {
    if (c.c === ' ' || c.c === '\t') { if (cur) { toks.push(cur); cur = null; } }
    else { if (!cur) cur = { text: '', x: c.x }; cur.text += c.c; }
  });
  if (cur) toks.push(cur);
  return toks;
}
function renderPaired(chordL, lyricL, cwRef, base) {
  const { s: lyr, cols: lcols, cw: lcw } = renderGeneric(lyricL, cwRef, base);
  const anchors = [];
  const chars = lyricL.chars;
  chars.forEach((c, i) => {
    if (c.c === '\t') { const span = Math.max(1, pyRound((c.x2 - c.x) / lcw)); for (let k = 0; k < span; k++) anchors.push([c.x + k * lcw, lcols[i] + k]); }
    else anchors.push([c.x, lcols[i]]);
  });
  if (chars.length) {
    const lastX2 = chars[chars.length - 1].x2, lastCol = lyr.length;
    for (let k = 0; k < 200; k++) anchors.push([lastX2 + k * lcw, lastCol + k]);
    const firstX = chars[0].x, firstCol = lcols.length ? lcols[0] : 0;
    for (let k = 1; k <= firstCol; k++) anchors.push([firstX - k * lcw, firstCol - k]);
  }
  let out = ''; const flags = []; let prevEnd = -1;
  for (const t of tokens(chordL)) {
    let best = null, bd = Infinity;
    for (const a of anchors) { const d = Math.abs(a[0] - t.x); if (d < bd - 1e-9 || (Math.abs(d - bd) < 1e-9 && a[1] > best)) { bd = d; best = a[1]; } }
    let second = Infinity, secondCol = null;
    for (const a of anchors) { if (a[1] === best) continue; const d = Math.abs(a[0] - t.x); if (d < second) { second = d; secondCol = a[1]; } }
    let col = best;
    if (second - bd < 0.06 * lcw && secondCol !== col) flags.push('half');
    if (col <= prevEnd) { flags.push('collision'); col = prevEnd + 1; }
    if (col < out.length) col = out.length + (out && !out.endsWith(' ') ? 1 : 0);
    out += ' '.repeat(col - out.length) + t.text;
    prevEnd = out.length;
  }
  return { c: out, l: lyr, flags };
}

const URL_RE = /https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\/\S+/i;
export const LINKTEXT = 'click on YouTube link';
function post(k, t) {
  const extra = {};
  const m = t.match(URL_RE);
  if (m) { extra.link = m[0]; t = t.slice(0, m.index) + LINKTEXT + t.slice(m.index + m[0].length); }
  if (['t', 'd', 'b'].includes(k) && !m) {
    const toks = [...t.matchAll(/\S+/g)].map(x => [x.index, x.index + x[0].length, x[0]]);
    const lab = t.match(LABEL_RE);
    let start = 0;
    if (lab) while (start < toks.length && toks[start][1] <= lab[0].length) start++;
    let j = start;
    while (j < toks.length && (xchord(toks[j][2]) || FILLER.test(toks[j][2]))) j++;
    if (j === toks.length && toks.slice(start).some(x => xchord(x[2])) && k === 't') k = 'c';
    else {
      let best = null;
      for (let kk = start + 1; kk <= Math.min(j, toks.length - 1); kk++)
        if (toks[kk][0] - toks[kk - 1][1] >= 3 && toks.slice(start, kk).some(x => xchord(x[2]))) best = kk;
      if (best !== null) {
        const rest = toks[best][2];
        if (!(/^\(?[0-9xX]{6}\)?$/.test(rest) || /^[0-9xX]([-,.][0-9xX]{1,2}){5}/.test(rest) || t.slice(toks[best][0]).includes('---') || /^[=:]/.test(rest))) { extra.split = toks[best][0]; k = 'c'; }
      }
    }
  }
  return Object.keys(extra).length ? [k, t, extra] : [k, t];
}

export function renderLines(lines, lowerOk = false) {
  const texts = lines.map(lineText);
  const kinds = texts.map(t => classify(t, lowerOk)[0]);
  const cnt = new Map();
  kinds.forEach((k, i) => { if (['chords', 'label+chords', 'text'].includes(k) && lines[i].chars.length) { const s = domSize(lines[i]); cnt.set(s, (cnt.get(s) || 0) + lines[i].chars.length); } });
  let refSz = 20, bn = -1; for (const [k, v] of cnt) if (v > bn) { refSz = k; bn = v; }
  const cwRef = cwOf(refSz);
  const xs = lines.filter(L => L.chars.length && !['center', 'right'].includes(L.jc) && !L.tableRow).map(L => L.chars[0].x);
  const base = Math.max(0, xs.length ? Math.min(...xs) : 0);
  const rendered = new Array(lines.length).fill(null);
  const paired = new Set();
  const stats = { half: 0, collision: 0, pairs: 0 };
  for (let i = 0; i < lines.length - 1; i++) {
    if (['chords', 'label+chords'].includes(kinds[i]) && kinds[i + 1] === 'text' && texts[i + 1].trim()) {
      let { c, l, flags } = renderPaired(lines[i], lines[i + 1], cwRef, base);
      if (flags.includes('collision')) { c = renderGeneric(lines[i], cwRef, base).s; stats.collision++; }
      stats.half += flags.filter(f => f === 'half').length;
      rendered[i] = c; rendered[i + 1] = l; paired.add(i); stats.pairs++;
    }
  }
  for (let i = 0; i < lines.length; i++) if (rendered[i] === null) {
    rendered[i] = renderGeneric(lines[i], cwRef, base).s;
    if (['center', 'right'].includes(lines[i].jc) && !['chords', 'label+chords'].includes(kinds[i])) rendered[i] = rendered[i].trimStart();
  }
  const KIND = { chords: 'c', 'label+chords': 'c', chorddef: 'd', tab: 'x', label: 'b', empty: 'e' };
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let k = KIND[kinds[i]] || 't';
    if (kinds[i] === 'text' && paired.has(i - 1)) k = 'l';
    out.push({ line: post(k, rendered[i].replace(/\s+$/, '')), imgs: [...new Set(lines[i].imgs)] });
  }
  return { out, stats, texts };
}

// ---------- public: import a .docx file ----------
export async function importDocx(file) {
  const buf = await file.arrayBuffer();
  const zip = await unzip(buf);
  const docXml = await zip.text('word/document.xml');
  if (!docXml) throw new Error('No Word document found in this file');
  const doc = new Doc(zip, docXml, await zip.text('word/styles.xml'), await zip.text('word/settings.xml'), await zip.text('word/theme/theme1.xml'), await zip.text('word/_rels/document.xml.rels'));
  const body = [...doc.doc.documentElement.children].find(c => c.localName === 'body');
  let colwidth = 9000;
  const sect = kid(body, 'sectPr');
  if (sect) {
    const pg = kid(sect, 'pgSz'), mar = kid(sect, 'pgMar');
    if (pg && mar) colwidth = ival(wa(pg, 'w')) - ival(wa(mar, 'left')) - ival(wa(mar, 'right'));
    const cols = kid(sect, 'cols');
    if (cols && ival(wa(cols, 'num'), 1) > 1) { const n = ival(wa(cols, 'num'), 1), sp = ival(wa(cols, 'space'), 720); colwidth = (colwidth - sp * (n - 1)) / n; }
  }
  const lines = [];
  walkBody(doc, body, colwidth, lines);
  // text boxes: their text goes on top as notes
  const notes = [];
  const seen = new Set();
  for (const tx of doc.doc.getElementsByTagNameNS(W, 'txbxContent')) {
    const t = [...tx.getElementsByTagNameNS(W, 'p')].map(p => layoutPara(doc, p, colwidth).map(lineText).join('\n')).join('\n').trim();
    if (t && !seen.has(t)) { seen.add(t); notes.push(...t.split('\n').filter(s => s.trim())); }
  }
  // page headers/footers: only used to find a capo instruction
  const hdr = [];
  for (const nm of zip.names().filter(x => /^word\/(header|footer)\d*\.xml$/.test(x))) {
    const x = new DOMParser().parseFromString(await zip.text(nm), 'application/xml');
    for (const p of x.getElementsByTagNameNS(W, 'p')) hdr.push([...p.getElementsByTagNameNS(W, 't')].map(t => t.textContent).join(''));
  }
  const lowerOk = /tell me it its not over/i.test(file.name);
  const { out, stats, texts } = renderLines(lines, lowerOk);
  // images
  const images = {};
  const outLines = [];
  for (const o of out) {
    outLines.push(o.line);
    for (const target of o.imgs) {
      const p = target.startsWith('word/') ? target : 'word/' + target.replace(/^\//, '');
      const bytes = await zip.bytes(p);
      if (!bytes || bytes.length < 300) continue;
      const mime = /\.png$/i.test(p) ? 'image/png' : /\.gif$/i.test(p) ? 'image/gif' : 'image/jpeg';
      const id = 'img-' + Math.abs(hash(bytes)).toString(36);
      images[id] = { mime, data: b64(bytes) };
      outLines.push(['i', id]);
    }
  }
  const meta = parseFilename(file.name);
  const own = meta.score === 6;
  const plain = texts.map(t => t.replace(/\t/g, ' '));
  let basedOn = null;
  if (own) {
    const bl = plain.find(t => /^(origineel lied|based on|op muziek van)\s*:/i.test(t.trim()));
    if (bl) { const v = bl.split(':').slice(1).join(':').trim(); const parts = v.split(/\s+[-–]\s+/); basedOn = { title: sentence(parts[0] || v), artist: parts[1] || '' }; }
  }
  return {
    song: {
      title: titleFromDoc(meta.title, plain), artist: own ? 'Erik' : normArtist(meta.artist), score: own ? 5 : (meta.score || 3), fileScore: meta.score,
      type: own ? 'own' : 'song', basedOn, capo: parseCapo(plain) ?? parseCapo(hdr) ?? (file.name.match(/capo\s*(\d{1,2})/i) ? parseInt(file.name.match(/capo\s*(\d{1,2})/i)[1], 10) : null), notes, chordDefs: parseDefs(texts),
      source: [file.name], nameKey: meta.key, format: 'docx',
      versions: [{ label: '', main: true, lines: outLines }],
    },
    images, stats,
  };
}
// Restore apostrophes the file name cannot hold ("Cant" -> "Can't") from the title as typed in the sheet.
function titleFromDoc(t, lines) {
  const norm = (x) => x.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
  const want = norm(t);
  for (const ln of lines.filter(x => x.trim()).slice(0, 4)) {
    const words = ln.trim().split(/\s+/);
    for (let i = 0; i < words.length; i++) for (let j = i + 1; j <= words.length; j++) {
      let cand = words.slice(i, j).join(' ').replace(/^[^\p{L}\d'’(]+|[^\p{L}\d'’)]+$/gu, '');
      if (!/^['’]k\b/i.test(cand)) cand = cand.replace(/^['’]+/, '');
      cand = cand.replace(/['’]+$/, '');
      if ((cand.match(/\(/g) || []).length !== (cand.match(/\)/g) || []).length) cand = cand.replace(/^\(|\)$/g, '');
      if (norm(cand) === want) return sentence(cand.replace(/[’‘]/g, "'"));
      if (norm(cand).length > want.length) break;
    }
  }
  return sentence(t);
}
function hash(u8) { let h = 2166136261; for (let i = 0; i < u8.length; i += Math.max(1, (u8.length / 4096) | 0)) { h ^= u8[i]; h = Math.imul(h, 16777619); } return h ^ u8.length; }
function b64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
