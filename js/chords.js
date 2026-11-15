// Chord recognition, line classification and helpers (ported from the Python audit tools).
const NOTE = '[A-G](?:#|b)?';
const QUAL = '(?:maj|Maj|min|m|M|dim|aug|sus|add|°|ø|\\+|-)?';
const EXT = '(?:(?:maj|Maj|sus|add|dim|aug|b|#|\\+|-|M)?\\d{1,2})*';
const SUS = '(?:sus\\d?)?';
const PAREN = '(?:\\([^)\\s]{1,8}\\))?';
const CHORD_RE = new RegExp('^\\(?' + NOTE + QUAL + EXT + SUS + EXT + PAREN + '(?:/' + NOTE + ')?\\*?\\)?[,.]?$');
export const FILLER = /^(?:\|+|\/+|-+|\.+|x\d+|\d+x|\(x?\d+x?\)|\(?\d+\s?x\)?|N\.?C\.?|%|>|<|\*+|\(|\)|:|riff|etc\.?|…|→|~+|\|\|:|:\|\|)$/i;
const PAREN_TAIL = /\((?:x?\d+x?|ring.*|single.*|alt.*|\d+.*)\)?$/i;
const RIFF_TOK = /^[A-G]-\d+$/;
export const LABEL_RE = /^\s*(\[[^\]]+\]|(?:intro|outro|verse|vers|couplet|strofe|chorus|refrein|refrain|bridge|pre-?chorus|solo|interlude|instrumental|ending|end|coda|tag|riff|brug|middle ?8|hook)\b[^:]*:?)/i;
const FRET = '(?:[0-9xXoO]|1[0-9])';
const FING = '\\(?((?:[0-9xX]{6})|(?:' + FRET + '[ \\-.,]){5}' + FRET + ')\\)?(?![\\w])';
export const DEF_RE = new RegExp('(?<![\\w#/])(' + NOTE + '[^\\s=:]{0,14})(?:\\s*[=:\\u2013\\-]+\\s*|\\s+)' + FING, 'g');
const DEF_TEST = new RegExp('(?<![\\w#/])(' + NOTE + '[^\\s=:]{0,14})(?:\\s*[=:\\u2013\\-]+\\s*|\\s+)' + FING);
const TABLINE_RE = /^(?:[eEBGDAa]|[EBGDA][b#])\s*(?:\|?-|\|)[-\d|xhpb/\\~()<>.\s]*$/;
const LOWER_CHORD = /^[a-g](#|b)?m?\d*$/;

function cleanTok(t) { return t.startsWith('(') ? t : t.replace(PAREN_TAIL, ''); }
export function isChord(t) { if (RIFF_TOK.test(t)) return false; return CHORD_RE.test(cleanTok(t)); }
export function chordName(t) { return cleanTok(t).replace(/^[(),.*]+|[(),.*]+$/g, ''); }

export function classify(line, lowerOk = false) {
  const s = line.replace(/\t/g, ' ').trim();
  if (!s) return ['empty', []];
  if (DEF_TEST.test(s)) return ['chorddef', []];
  if (TABLINE_RE.test(s)) return ['tab', []];
  let rest = s.split(/\s+/);
  let label = false;
  const m = s.match(LABEL_RE);
  if (m) { label = true; rest = s.slice(m[0].length).split(/\s+/).filter(Boolean); }
  const chords = rest.filter(isChord);
  const others = rest.filter(t => !isChord(t) && !FILLER.test(t));
  if (chords.length && others.length === 0) return [label ? 'label+chords' : 'chords', chords.map(chordName)];
  if (chords.length >= 2 && others.length <= 1 && others.length < chords.length / 2) return [label ? 'label+chords' : 'chords', chords.map(chordName)];
  if (label && rest.length <= 4) return ['label', []];
  if (lowerOk) {
    const toks = s.replace(/,/g, ' ').split(/\s+/);
    if (toks.length && toks.every(x => LOWER_CHORD.test(x))) return ['chords', toks];
  }
  return ['text', []];
}

export function xchord(tok) {
  tok = tok.replace(/^\(+|\)+$/g, '').replace(/[’'*]+$/, '');
  const parts = isChord(tok) ? [tok] : tok.split(/[-–/]/).filter(Boolean);
  return parts.length > 0 && parts.every(p => isChord(p.replace(/[’'*]+$/, '')));
}

// Sentence case: capital first letter, rest lower; standalone "I" stays capital.
export function sentence(t) {
  t = t.trim().replace(/\s+/g, ' ');
  let low = t.toLowerCase().replace(/(?<![\w'])i(?=('m|'ll|'ve|'d)?(?![\w']))/g, 'I');
  const i = low.search(/[\p{L}\d]/u);
  if (i < 0 || /\d/.test(low[i])) return low;
  return low.slice(0, i) + low[i].toUpperCase() + low.slice(i + 1);
}

export const ARTIST_MAP = {
  'Andre Hazes Jr': 'André Hazes Jr.', 'Bart en Hugo': 'Bart Peeters', 'Bears Den': "Bear's Den", 'Ben E King': 'Ben E. King',
  'Bill Witters': 'Bill Withers', 'Blind Boys of Alabama': 'The Blind Boys of Alabama', 'Blink 182': 'Blink-182',
  'Cranberries': 'The Cranberries', 'Creedence': 'Creedence Clearwater Revival', 'Delamitri': 'Del Amitri', 'Dubliners': 'The Dubliners',
  "GnR": "Guns N' Roses", 'GNR': "Guns N' Roses", 'guns n roses': "Guns N' Roses", 'Lemonheads': 'The Lemonheads',
  'Nathaniel Ratecliff': 'Nathaniel Rateliff', 'OCMS': 'Old Crow Medicine Show', 'RHCP': 'Red Hot Chili Peppers',
  'Rodney Carrinton': 'Rodney Carrington', 'Rolling Stones': 'The Rolling Stones', 'Smashing Pumpkins': 'The Smashing Pumpkins',
  'Therapy': 'Therapy?', 'Eagle Eye Cherry': 'Eagle-Eye Cherry', 'Mumford and Sons': 'Mumford & Sons', 'Mumford n Sons': 'Mumford & Sons',
  'ABBA': 'Abba', 'INXS': 'Inxs',
};
export function normArtist(a) {
  if (!a) return '';
  a = a.trim();
  for (const [k, v] of Object.entries(ARTIST_MAP)) if (k.toLowerCase() === a.toLowerCase()) return v;
  if (a === a.toUpperCase() && /[A-Z]{3,}/.test(a) && !/\d/.test(a)) a = a.toLowerCase();
  // capitalise each word if the name is all lower case
  if (a === a.toLowerCase()) a = a.replace(/(^|[\s(-])(\p{L})/gu, (m, p, c) => p + c.toUpperCase());
  return a;
}

// filename "<score> <Title> - <Artist>.<ext>"
export function parseFilename(fn) {
  const base = fn.replace(/\.[^.]+$/, '');
  const m = base.match(/^(\d)\s*(.*)$/);
  let score = null, rest = base;
  if (m) { score = parseInt(m[1], 10); rest = m[2]; }
  rest = rest.trim().replace(/\s+/g, ' ');
  let parts = rest.split(/\s*-\s+|\s+-\s*/);
  if (parts.length === 1 && rest.includes('-')) parts = rest.split('-');
  const title = parts[0].trim();
  const artist = parts.length > 1 ? parts.slice(1).join(' - ').trim() : '';
  return { score, title, artist, key: nameKey(fn) };
}
export function nameKey(fn) {
  return fn.replace(/\.[^.]+$/, '').replace(/^\d\s*/, '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
}

const ORD = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9 };
export function parseCapo(lines) {
  for (const t0 of lines.slice(0, 30)) {
    const t = t0.toLowerCase();
    if (!t.includes('capo')) continue;
    if (/relative to (the )?capo|tabbed with capo|capoed fret|with no capo/.test(t) && !/capo\s*:?\s*(on|op)?\s*:?\s*\d/.test(t)) continue;
    if (/(no|zonder|geen)\s+capo/.test(t) && !/capo\s*:?\s*(on|op)?\s*:?\s*\d/.test(t)) return null;
    let m = t.match(/capo\s*:?\s*(?:on|op)?\s*:?\s*(?:the\s+)?(?:fret\s*)?(\d{1,2})/);
    if (m) return parseInt(m[1], 10) || null;
    m = t.match(/capo\s*:?\s*(?:on|op)?\s*:?\s*(?:the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)/);
    if (m) return ORD[m[1]];
  }
  return null;
}

// Chord fingerings written in the sheet (same rules as the first conversion).
const FING_TOK = /(?<![\w|\-])\(?((?:[0-9xX]{6})|(?:(?:[0-9xX]|1[0-9])[ .,]){5}(?:[0-9xX]|1[0-9]))\)?(?![\w|\-])/g;
const FING_FULL = /^\(?((?:[0-9xX]{6})|(?:(?:[0-9xX]|1[0-9])[ .,]){5}(?:[0-9xX]|1[0-9]))\)?$/;
const SKIPW = /^(?:is|als|like|kan|hier|gewoon|ook|chord|akkoord|=|:|-|–|play|speel|spelen|je|dus|eerder|versie|of|or|=>|->|→|\(|\)|\||alt:?|alternatief:?|en|and|nu|met|zonder|eigenlijk|wordt|hier:|\*)$/i;
const NOTE_ANY = new RegExp('^' + NOTE + '\\S{0,14}$');
const SKIPDEF = new Set(['G|000000', 'Cadd9|020000', 'C/B|000030', 'C/B|300010', 'Am|030050']);
const stripW = (w) => w.replace(/^[(),:;|*]+|[(),:;|*]+$/g, '');
export function parseDefs(lines) {
  const out = [];
  const add = (name, fing) => { if (!SKIPDEF.has(name + '|' + fing) && !out.some(d => d.name === name && d.fing === fing)) out.push({ name, fing }); };
  const L = lines.map(t => t.replace(/\t/g, '    '));
  const cls = L.map(t => classify(t));
  L.forEach((tt, i) => {
    if (cls[i][0] === 'tab' || /^\s*fingers?\b/i.test(tt)) return;
    const ms = [...tt.matchAll(FING_TOK)];
    for (const m of ms) {
      const fing = m[1].replace(/[ \-.]/g, '').toUpperCase().replace(/O/g, '0').toLowerCase();
      if (!/[0-9]/.test(fing)) continue;
      const left = tt.slice(0, m.index).replace(/=/g, ' = ').replace(/:/g, ' : ').split(/\s+/).filter(Boolean);
      let name = null;
      for (const w of left.slice(-6).reverse()) {
        const w2 = stripW(w);
        if (FING_FULL.test(w) || /^[0-9x]{6}$/.test(w2)) continue;
        if (isChord(w2) || (NOTE_ANY.test(w2) && !/^[A-G][a-z]{3,}$/.test(w2))) { name = w2.replace(/[=:\-–]+$/, ''); break; }
        if (!w2 || SKIPW.test(w2)) continue;
        break;
      }
      const end = m.index + m[0].length;
      for (const off of [-1, -2, 1]) {
        if (name !== null || ms.length < 2) break;
        const j = i + off; if (j < 0 || j >= L.length) continue;
        for (const mm of L[j].matchAll(/\S+/g)) {
          const tok = mm[0].replace(/^[(),|*]+|[(),|*]+$/g, '');
          if (mm.index <= end && mm.index + mm[0].length >= m.index && isChord(tok)) { name = chordName(mm[0].replace(/^[|*]+|[|*]+$/g, '')); break; }
        }
      }
      if (name) add(name, fing);
    }
  });
  // chord names above six tab lines
  for (let i = 0; i < L.length; i++) {
    if (!['chords', 'label+chords'].includes(cls[i][0])) continue;
    const block = []; let j = i + 1;
    while (j < L.length && TABLINE_RE.test(L[j].trim() || 'zz')) { block.push(L[j]); j++; }
    if (block.length === 6) {
      const names = cls[i][1];
      const toks = block.map(b => b.replace(/^\s*(?:[eEBGDAa]|[EBGDA][b#])\s*/, '').match(/\d{1,2}|[xX]/g) || []);
      if (names.length && toks.every(t => t.length === names.length)) names.forEach((nm, ci) => {
        const fr = toks.map(t => t[ci].toLowerCase()).reverse();
        add(nm, fr.every(f => f.length === 1) ? fr.join('') : fr.join('-'));
      });
      i = j - 1;
    }
  }
  // vertical "E-0 A-2 ..." notation under a chord line
  for (let i = 0; i < L.length - 6; i++) {
    if (!['chords', 'label+chords'].includes(cls[i][0])) continue;
    const rows = []; let j = i + 1;
    while (j < L.length && /^\s*(?:[EBGDAe]-[0-9xX]{1,2}\s*)+$/.test(L[j])) { rows.push([...lines[j].matchAll(/([EBGDAe])-([0-9xX]{1,2})/g)].map(x => [x[1], x[2]])); j++; }
    const names = cls[i][1];
    if (rows.length >= 4 && rows.every(r => r.length === names.length)) names.forEach((nm, ci) => {
      const fr = Array(6).fill('x'); let seenE = 0;
      for (const [sn, f0] of rows.map(r => r[ci])) {
        const f = f0.toLowerCase();
        if ((sn === 'E' || sn === 'e') && !seenE) { fr[5] = f; seenE = 1; }
        else if (sn === 'B') fr[4] = f; else if (sn === 'G') fr[3] = f; else if (sn === 'D') fr[2] = f; else if (sn === 'A') fr[1] = f;
        else if (sn === 'E' || sn === 'e') fr[0] = f;
      }
      add(nm, fr.join(''));
    });
  }
  return out;
}

// Chords common enough that a text fingering suffices (no diagram).
const COMMON = /^[A-G](#|b)?(m|7|m7|maj7|sus2|sus4|add9|5|6|2|4|9|maj|min)?$/;
const COMMON_SLASH = new Set(['D/F#', 'G/B', 'C/B', 'C/G', 'C/E', 'A/C#', 'G/F#', 'Am/G', 'D/A', 'E/G#', 'F/A', 'F/C']);
export function needsDiagram(name) { return !(COMMON.test(name) || COMMON_SLASH.has(name)); }

export function fretsOf(fing) {
  let f = fing.toLowerCase();
  let arr;
  if (/^[0-9x]{6}$/.test(f)) arr = f.split('');
  else arr = f.split(/[-,]/).filter(Boolean);
  if (arr.length !== 6) return null;
  return arr.map(x => (x === 'x' ? -1 : parseInt(x, 10)));
}

export function diagramSVG(fing, color) {
  const fr = fretsOf(fing);
  if (!fr) return '';
  const played = fr.filter(x => x > 0);
  const min = played.length ? Math.min(...played) : 1;
  const max = played.length ? Math.max(...played) : 1;
  const start = max <= 4 ? 1 : min;
  const W = 70, H = 84, x0 = 12, y0 = 18, dx = 10, dy = 14;
  let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="diagram ${fing}" style="color:${color}">`;
  for (let i = 0; i < 6; i++) s += `<line x1="${x0 + i * dx}" y1="${y0}" x2="${x0 + i * dx}" y2="${y0 + 4 * dy}" stroke="currentColor" stroke-width="1"/>`;
  for (let j = 0; j <= 4; j++) s += `<line x1="${x0}" y1="${y0 + j * dy}" x2="${x0 + 5 * dx}" y2="${y0 + j * dy}" stroke="currentColor" stroke-width="${j === 0 && start === 1 ? 3 : 1}"/>`;
  if (start > 1) s += `<text x="${x0 + 5 * dx + 4}" y="${y0 + dy - 3}" font-size="9" fill="currentColor">${start}fr</text>`;
  fr.forEach((f, i) => {
    const x = x0 + i * dx;
    if (f < 0) s += `<text x="${x - 3}" y="${y0 - 5}" font-size="9" fill="currentColor">x</text>`;
    else if (f === 0) s += `<circle cx="${x}" cy="${y0 - 8}" r="3" fill="none" stroke="currentColor"/>`;
    else s += `<circle cx="${x}" cy="${y0 + (f - start + 0.5) * dy}" r="4" fill="currentColor"/>`;
  });
  return s + '</svg>';
}
