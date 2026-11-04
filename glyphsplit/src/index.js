'use strict';

/**
 * glyphsplit
 *
 * Splits one TrueType font into two files that are useless on their own:
 *
 *  - Metrics font (A): advance widths, kerning and OpenType features of the
 *    original, but no outlines. Installed, it draws nothing.
 *  - Glyph font (B): the outlines, but mirrored left/right at the centre of the
 *    colon, each glyph moved sideways by its own random distance, scrambled
 *    advance widths, no layout tables, no hinting, composites resolved, glyphs on
 *    scrambled private-use code points. Opened in a font editor it does not show
 *    a font as a whole; every glyph needs its own correction before use.
 *
 * Both files carry restricted-licence embedding (OS/2 fsType), copyright and
 * licence text, and an ID in the PostScript name. Optional fingerprint glyphs
 * with the copyright text as glyph name replace a few unkerned letters through
 * GSUB, and look exactly like them.
 *
 * In the browser, the client lays out text with A (invisible), shapes it with
 * HarfBuzz using A, and draws each glyph from B, undoing mirror and offset.
 */

const crypto = require('crypto');
const { readTables, writeFont, clone, cmapFormat4, cmapFormat12, buildCmap, buildPost, readNames, nameString, buildName } = require('./sfnt');
const { outlineReader, encodeSimple, bboxOf, mirror, shiftX, readLoca, transformGlyph } = require('./glyf');
const { addSubstitution } = require('./gsub');

const LAYOUT_TABLES = ['GSUB', 'GPOS', 'GDEF', 'kern', 'BASE', 'JSTF', 'MATH', 'morx', 'kerx', 'feat', 'trak'];
const HINTING_TABLES = ['fpgm', 'prep', 'cvt ', 'hdmx', 'LTSH', 'VDMX'];
const FS_TYPE = { installable: 0x0000, restricted: 0x0002, preview: 0x0004, editable: 0x0008 };
const FINGERPRINT_FEATURES = ['calt', 'liga', 'rlig'];
const FINGERPRINT_CANDIDATES = 'enisratdhulcgmobwfkzpvjyxq';
/** Hard cap for the sideways offset of a glyph, in em. */
const MAX_JITTER_EM = 0.5;

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ---------- fingerprint helpers ----------

const AGL = {
  ' ': 'space', '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four', '5': 'five', '6': 'six', '7': 'seven',
  '8': 'eight', '9': 'nine', '©': 'copyright', '.': 'period', ',': 'comma', '-': 'hyphen', ':': 'colon', '/': 'slash',
  '&': 'ampersand', '@': 'at', '(': 'parenleft', ')': 'parenright', "'": 'quotesingle', '_': 'underscore', '+': 'plus',
};
/** Text -> Adobe Glyph List components. Joined with "_", text extractors that read glyph names get the text back. */
function aglTokens(text) {
  return Array.from(text).map((ch) => {
    if (/[A-Za-z]/.test(ch)) return ch;
    if (AGL[ch]) return AGL[ch];
    return 'uni' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
  });
}
function chunkNames(tokens, maxLen) {
  const out = [];
  let cur = [];
  for (const t of tokens) {
    const next = cur.concat(t).join('_');
    if (cur.length && next.length > maxLen) { out.push(cur); cur = [t]; } else cur.push(t);
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * For each candidate letter: the letters it can follow and precede without any
 * kerning in between. Only there is it replaced, so kerning stays exactly as before.
 */
async function kerningFreeContexts(fontBuf, cmap) {
  let hb;
  try { hb = await require('harfbuzzjs'); } catch (e) { return null; }
  const face = hb.createFace(hb.createBlob(fontBuf), 0);
  const font = hb.createFont(face);
  const width = (t, f) => {
    const b = hb.createBuffer(); b.addText(t); b.guessSegmentProperties(); hb.shape(font, b, f);
    const w = b.json().reduce((s, g) => s + g.ax + g.dx, 0); b.destroy(); return w;
  };
  const letters = Array.from('abcdefghijklmnopqrstuvwxyz').filter((c) => cmap.has(c.codePointAt(0)));
  const out = [];
  for (const ch of FINGERPRINT_CANDIDATES) {
    if (!cmap.has(ch.codePointAt(0))) continue;
    const prev = letters.filter((p) => width(p + ch, '') === width(p + ch, 'kern=0'));
    const next = letters.filter((n) => width(ch + n, '') === width(ch + n, 'kern=0'));
    if (prev.length >= 3 && next.length >= 3) out.push({ letter: ch, prev, next });
  }
  return out;
}

function readCmapMap(cmap) {
  // best Unicode subtable -> Map(codepoint -> gid)
  const n = cmap.readUInt16BE(2), map = new Map();
  let best = null;
  for (let i = 0; i < n; i++) {
    const r = 4 + i * 8, pid = cmap.readUInt16BE(r), eid = cmap.readUInt16BE(r + 2), off = cmap.readUInt32BE(r + 4);
    const fmt = cmap.readUInt16BE(off);
    if ((pid === 3 && eid === 10 && fmt === 12) || (pid === 0 && fmt === 12)) { best = { off, fmt }; break; }
    if (((pid === 3 && eid === 1) || pid === 0) && fmt === 4 && !best) best = { off, fmt };
  }
  if (!best) return map;
  const o = best.off;
  if (best.fmt === 12) {
    for (let i = 0, ng = cmap.readUInt32BE(o + 12); i < ng; i++) {
      const r = o + 16 + i * 12, s = cmap.readUInt32BE(r), e = cmap.readUInt32BE(r + 4), g = cmap.readUInt32BE(r + 8);
      for (let c = s; c <= e; c++) map.set(c, g + c - s);
    }
  } else {
    const segX2 = cmap.readUInt16BE(o + 6), ends = o + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ros = deltas + segX2;
    for (let i = 0; i < segX2 / 2; i++) {
      const end = cmap.readUInt16BE(ends + i * 2), start = cmap.readUInt16BE(starts + i * 2);
      const delta = cmap.readInt16BE(deltas + i * 2), ro = cmap.readUInt16BE(ros + i * 2);
      for (let c = start; c <= end && c !== 0xffff; c++) {
        let gid = ro === 0 ? (c + delta) & 0xffff : cmap.readUInt16BE(ros + i * 2 + ro + (c - start) * 2);
        if (ro !== 0 && gid) gid = (gid + delta) & 0xffff;
        if (gid) map.set(c, gid);
      }
    }
  }
  return map;
}

// ---------- per-glyph tables, extended for added glyphs ----------

/** vhea/vmtx: write one long metric per glyph; added glyphs copy their base glyph. */
function extendVertical(t, n0, n, baseOf) {
  if (!t.vhea || !t.vmtx) return;
  const nV = t.vhea.readUInt16BE(34);
  const adv = (i) => t.vmtx.readUInt16BE(Math.min(i, nV - 1) * 4);
  const tsb = (i) => (i < nV ? t.vmtx.readInt16BE(i * 4 + 2) : t.vmtx.readInt16BE(nV * 4 + (i - nV) * 2));
  const out = Buffer.alloc(n * 4);
  for (let g = 0; g < n; g++) { const s = baseOf(g); out.writeUInt16BE(adv(s), g * 4); out.writeInt16BE(tsb(s), g * 4 + 2); }
  t.vmtx = out;
  t.vhea.writeUInt16BE(n, 34);
}

/** hdmx and LTSH hold one value per glyph and size; added glyphs copy their base glyph. */
function extendDevice(t, n0, n, baseOf) {
  if (n === n0) return;
  if (t.hdmx) {
    const h = t.hdmx, nrec = h.readInt16BE(2), size0 = h.readInt32BE(4);
    const size = (2 + n + 3) & ~3;
    const out = Buffer.alloc(8 + nrec * size);
    out.writeUInt16BE(0, 0); out.writeInt16BE(nrec, 2); out.writeInt32BE(size, 4);
    for (let r = 0; r < nrec; r++) {
      const src = 8 + r * size0, dst = 8 + r * size;
      out[dst] = h[src]; out[dst + 1] = h[src + 1];
      for (let g = 0; g < n; g++) out[dst + 2 + g] = h[src + 2 + baseOf(g)];
    }
    t.hdmx = out;
  }
  if (t.LTSH) {
    const l = t.LTSH, out = Buffer.alloc(4 + n);
    out.writeUInt16BE(l.readUInt16BE(0), 0); out.writeUInt16BE(n, 2);
    for (let g = 0; g < n; g++) out[4 + g] = l[4 + baseOf(g)];
    t.LTSH = out;
  }
}

// ---------- main ----------

/**
 * @param {Buffer} input  TTF with TrueType outlines
 * @param {object} [o]
 * @param {boolean} [o.mirror=true]       mirror glyphs left/right at the centre of the colon
 * @param {boolean} [o.jitter=true]       move every glyph sideways by its own random distance
 * @param {number}  [o.jitterEm=0.5]      maximum distance in em, capped at 0.5
 * @param {string}  [o.embedding='restricted']  OS/2 fsType: restricted | preview | editable | installable
 * @param {string}  [o.copyright]         copyright text (name ID 0 and fingerprint)
 * @param {string}  [o.license]           licence text (name ID 13)
 * @param {string}  [o.licenseUrl]        licence URL (name ID 14)
 * @param {string}  [o.id]                ID added to the PostScript name (default: random)
 * @param {boolean} [o.uuid=false]        replace family and PostScript names with a UUID
 * @param {boolean} [o.fingerprint=true]  add fingerprint glyphs
 * @param {boolean} [o.resolveComposites=false]  turn composites into plain outlines (drops their hinting)
 */
async function splitFont(input, o = {}) {
  const opts = {
    mirror: o.mirror !== false, jitter: o.jitter !== false, jitterEm: Math.min(o.jitterEm || MAX_JITTER_EM, MAX_JITTER_EM),
    embedding: o.embedding || 'restricted', fingerprint: o.fingerprint !== false, uuid: !!o.uuid,
    resolveComposites: !!o.resolveComposites,
  };
  if (!(opts.embedding in FS_TYPE)) throw new Error(`embedding must be one of ${Object.keys(FS_TYPE).join(', ')}`);
  const warnings = [];
  const { sfntVersion, tables } = readTables(await toTtf(input));
  if (sfntVersion === 0x4f54544f) throw new Error('Only fonts with TrueType outlines (glyf table) are supported, not CFF/OpenType (OTTO).');
  if (!tables.glyf || !tables.loca) throw new Error('Only fonts with TrueType outlines (glyf table) are supported.');
  if (tables.fvar) throw new Error('Variable fonts are not supported. Export a static instance first.');

  const numGlyphs0 = tables.maxp.readUInt16BE(4);
  const upm = tables.head.readUInt16BE(18);
  const loca = readLoca(tables.head, tables.loca, numGlyphs0);
  const outline = outlineReader(tables.glyf, loca, numGlyphs0);
  const isComposite = (i) => loca[i + 1] > loca[i] && tables.glyf.readInt16BE(loca[i]) < 0;
  const numH = tables.hhea.readUInt16BE(34);
  const advOf = (i) => tables.hmtx.readUInt16BE(Math.min(i, numH - 1) * 4);
  const lsbOf = (i) => (i < numH ? tables.hmtx.readInt16BE(i * 4 + 2) : tables.hmtx.readInt16BE(numH * 4 + (i - numH) * 2));
  const cmap = readCmapMap(tables.cmap);

  // ---- names and IDs ----
  const nameRecs = readNames(tables.name);
  const id = opts.uuid ? crypto.randomUUID() : (o.id || crypto.randomBytes(4).toString('hex'));
  const copyright = o.copyright || nameString(nameRecs, 0);
  const origFamily = nameString(nameRecs, 16) || nameString(nameRecs, 1);
  const origPs = nameString(nameRecs, 6) || origFamily.replace(/[^A-Za-z0-9-]/g, '');
  const psName = opts.uuid ? 'F' + id.replace(/-/g, '') : (origPs + '-' + id).replace(/[^\x21-\x7e]|[[\](){}<>/%]/g, '').slice(0, 63);
  const nameReplace = {
    0: copyright || null,
    3: `${psName};glyphsplit`,
    6: psName,
    13: o.license || nameString(nameRecs, 13) || null,
    14: o.licenseUrl || nameString(nameRecs, 14) || null,
    18: null, 21: null, 22: null,
  };
  if (opts.uuid) Object.assign(nameReplace, { 1: id, 4: id, 16: null, 17: null });

  // ---- fingerprint glyphs: copies of unkerned letters, named with the copyright text ----
  const fp = []; // { base, gid, name }
  if (opts.fingerprint) {
    const text = (copyright || '') + (copyright ? ' ' : '') + 'ID ' + id;
    const safe = await kerningFreeContexts(input, cmap);
    if (safe === null) warnings.push('Fingerprint skipped: harfbuzzjs is not installed.');
    else {
      const chunks = chunkNames(aglTokens(text), 58);
      if (chunks.length > safe.length) warnings.push(`Fingerprint shortened: only ${safe.length} suitable letters were found.`);
      chunks.slice(0, safe.length).forEach((tokens, i) => {
        const s = safe[i], gid = (c) => cmap.get(c.codePointAt(0));
        fp.push({ base: gid(s.letter), gid: numGlyphs0 + i, name: tokens.join('_') + '.' + (i + 1), letter: s.letter,
          prev: s.prev.map(gid), next: s.next.map(gid) });
      });
    }
  }
  const numGlyphs = numGlyphs0 + fp.length;
  const baseOf = (g) => (g < numGlyphs0 ? g : fp[g - numGlyphs0].base);
  const glyphNames = Array.from({ length: numGlyphs }, (_, g) => (g === 0 ? '.notdef' : g < numGlyphs0 ? 'g' + g : fp[g - numGlyphs0].name));

  // ---- mirror axis: centre of the colon, rounded down when it falls between two units ----
  let axis = 0;
  if (opts.mirror) {
    const colon = cmap.get(0x3a);
    const bb = colon ? bboxOf(outline(colon)) : null;
    if (bb) axis = Math.floor((bb[0] + bb[2]) / 2);
    else { axis = Math.floor(advOf(cmap.get(0x20) || 0) / 2); warnings.push('The font has no colon; mirrored at half the width of the space instead.'); }
  }

  // ---- per-glyph sideways offsets ----
  const maxJ = Math.round(opts.jitterEm * upm), minJ = Math.min(Math.round(0.25 * upm), maxJ);
  const offsets = new Int32Array(numGlyphs);
  if (opts.jitter) {
    for (let g = 0; g < numGlyphs; g++) {
      const mag = minJ + crypto.randomInt(Math.max(1, maxJ - minJ));
      offsets[g] = crypto.randomInt(2) ? mag : -mag;
    }
  }

  // ================= A: metrics font =================
  const a = clone(tables);
  a.glyf = Buffer.alloc(12); // browsers reject an empty glyf table; .notdef keeps a glyph without contours
  a.loca = Buffer.alloc((numGlyphs + 1) * 4);
  for (let i = 1; i <= numGlyphs; i++) a.loca.writeUInt32BE(12, i * 4);
  a.head.writeInt16BE(1, 50);
  [36, 38, 40, 42].forEach((p) => a.head.writeInt16BE(0, p));
  // The metrics font has no outlines: hinting programs have nothing to work on.
  ['fpgm', 'prep', 'cvt ', 'DSIG'].forEach((t) => delete a[t]);
  // Tables with one entry per glyph get entries for the fingerprint glyphs (copies of their letter).
  extendVertical(a, numGlyphs0, numGlyphs, baseOf);
  extendDevice(a, numGlyphs0, numGlyphs, baseOf);
  const hmA = Buffer.alloc(numGlyphs * 4);
  for (let g = 0; g < numGlyphs; g++) { hmA.writeUInt16BE(advOf(baseOf(g)), g * 4); hmA.writeInt16BE(lsbOf(baseOf(g)), g * 4 + 2); }
  a.hmtx = hmA;
  a.hhea.writeUInt16BE(numGlyphs, 34);
  a.maxp.writeUInt16BE(numGlyphs, 4);
  if (fp.length) {
    const r = addSubstitution(a.GSUB, fp.map((f) => ({ from: f.base, to: f.gid, prev: f.prev, next: f.next })), FINGERPRINT_FEATURES);
    a.GSUB = r.gsub;
    warnings.push(...r.warnings);
  }

  // ================= B: glyph font =================
  const b = clone(tables);
  LAYOUT_TABLES.forEach((t) => delete b[t]);
  // hdmx and LTSH describe advance widths in pixels; those widths are scrambled here.
  ['hdmx', 'LTSH', 'DSIG'].forEach((t) => delete b[t]);
  extendVertical(b, numGlyphs0, numGlyphs, baseOf); // y is untouched, so vertical metrics stay valid
  // x' = m*x + T: mirrored at the axis (m = -1) and moved by the glyph's own offset
  const m = opts.mirror ? -1 : 1;
  const Tof = (g) => (opts.mirror ? 2 * axis : 0) + (opts.jitter ? offsets[g] : 0);
  const rawGlyph = (i) => tables.glyf.subarray(loca[i], loca[i + 1]);
  const glyphs = [], bounds = [];
  let resolvedCount = 0;
  for (let g = 0; g < numGlyphs; g++) {
    const base = baseOf(g);
    if (opts.resolveComposites && isComposite(base)) {
      // optional: composites become plain outlines (their hinting is dropped)
      let c = outline(base);
      if (opts.mirror) c = mirror(c, axis);
      c = shiftX(c, opts.jitter ? offsets[g] : 0);
      const enc = encodeSimple(c, true);
      glyphs.push(enc.data); bounds.push(enc.bbox); resolvedCount++;
      continue;
    }
    const r = transformGlyph(rawGlyph(base), m, Tof(g), Tof, () => bboxOf(outline(base)));
    glyphs.push(r.data); bounds.push(r.bbox);
  }
  const parts = [], newLoca = Buffer.alloc((numGlyphs + 1) * 4);
  let off = 0;
  glyphs.forEach((d, i) => {
    newLoca.writeUInt32BE(off, i * 4);
    const pad = (4 - (d.length % 4)) % 4;
    parts.push(d, Buffer.alloc(pad)); off += d.length + pad;
  });
  newLoca.writeUInt32BE(off, numGlyphs * 4);
  b.glyf = Buffer.concat(parts);
  b.loca = newLoca;
  b.head.writeInt16BE(1, 50);
  // maxp: outlines and programs are unchanged, only the glyph count grows.
  // Resolved composites can have more points than any simple glyph before.
  b.maxp.writeUInt16BE(numGlyphs, 4);
  if (resolvedCount && b.maxp.length >= 32) {
    let mp = b.maxp.readUInt16BE(6), mc = b.maxp.readUInt16BE(8);
    glyphs.forEach((d) => {
      if (d.length < 12 || d.readInt16BE(0) < 0) return;
      const n = d.readInt16BE(0);
      mc = Math.max(mc, n);
      if (n) mp = Math.max(mp, d.readUInt16BE(10 + (n - 1) * 2) + 1);
    });
    b.maxp.writeUInt16BE(mp, 6); b.maxp.writeUInt16BE(mc, 8);
  }
  // scrambled advance widths, side bearing = left edge of the moved outline
  const hmB = Buffer.alloc(numGlyphs * 4);
  let maxAdv = 0, minLsb = 0x7fff, minRsb = 0x7fff, maxExt = -0x8000;
  let x0 = 0x7fff, y0 = 0x7fff, x1 = -0x8000, y1 = -0x8000;
  for (let g = 0; g < numGlyphs; g++) {
    const adv = Math.round(upm * (0.2 + crypto.randomInt(1000) / 1000));
    const bb = bounds[g];
    hmB.writeUInt16BE(adv, g * 4);
    hmB.writeInt16BE(bb ? bb[0] : 0, g * 4 + 2);
    maxAdv = Math.max(maxAdv, adv);
    if (!bb) continue;
    minLsb = Math.min(minLsb, bb[0]); minRsb = Math.min(minRsb, adv - bb[2]); maxExt = Math.max(maxExt, bb[2]);
    x0 = Math.min(x0, bb[0]); y0 = Math.min(y0, bb[1]); x1 = Math.max(x1, bb[2]); y1 = Math.max(y1, bb[3]);
  }
  b.hmtx = hmB;
  b.hhea.writeUInt16BE(numGlyphs, 34);
  b.hhea.writeUInt16BE(maxAdv, 10);
  b.hhea.writeInt16BE(minLsb, 12); b.hhea.writeInt16BE(Math.max(-32768, minRsb), 14); b.hhea.writeInt16BE(maxExt, 16);
  b.head.writeInt16BE(x0, 36); b.head.writeInt16BE(y0, 38); b.head.writeInt16BE(x1, 40); b.head.writeInt16BE(y1, 42);
  // glyph id -> scrambled private-use code point
  const bmp = numGlyphs - 1 <= 0xf8ff - 0xe000 + 1;
  const puaBase = bmp ? 0xe000 : 0xf0000;
  const slots = shuffle(Array.from({ length: numGlyphs - 1 }, (_, i) => i));
  const codes = new Array(numGlyphs).fill(0);
  for (let g = 1; g < numGlyphs; g++) codes[g] = puaBase + slots[g - 1];
  if (bmp) {
    const gids = new Array(numGlyphs - 1);
    for (let g = 1; g < numGlyphs; g++) gids[codes[g] - puaBase] = g;
    b.cmap = buildCmap([[3, 1, cmapFormat4(puaBase, gids)]]);
  } else {
    const pairs = [];
    for (let g = 1; g < numGlyphs; g++) pairs.push([codes[g], g]);
    b.cmap = buildCmap([[3, 1, cmapFormat4(0, [])], [3, 10, cmapFormat12(pairs)]]);
  }
  if (b['OS/2']) {
    b['OS/2'].writeUInt16BE(bmp ? puaBase : 0xffff, 64);
    b['OS/2'].writeUInt16BE(bmp ? puaBase + numGlyphs - 2 : 0xffff, 66);
  }

  // ================= shared: embedding, names, glyph names =================
  for (const t of [a, b]) {
    if (t['OS/2']) t['OS/2'].writeUInt16BE(FS_TYPE[opts.embedding], 8);
    t.name = buildName(nameRecs, nameReplace);
    if (t.post) t.post = buildPost(t.post, glyphNames);
  }

  return {
    metrics: writeFont(sfntVersion, a),
    glyphs: writeFont(sfntVersion, b),
    codes,
    offsets: Array.from(offsets),
    axis: opts.mirror ? axis : null,
    hinting: !!tables.fpgm || !!tables.prep || !!tables['cvt '],
    unitsPerEm: upm,
    numGlyphs,
    id,
    postScriptName: psName,
    fingerprint: fp.map((f) => ({ letter: f.letter, glyphName: f.name })),
    warnings,
  };
}

function loadWawoff2() {
  try { return require('wawoff2'); } catch (e) {
    throw new Error('WOFF2 input and output need the optional package "wawoff2": npm install wawoff2');
  }
}

/** Convert a TTF buffer to WOFF2 (needs the optional dependency `wawoff2`). */
async function toWoff2(ttf) {
  return Buffer.from(await loadWawoff2().compress(ttf));
}

/** Accept a TTF or a WOFF2 buffer; WOFF2 is decompressed first. */
async function toTtf(input) {
  if (input.length >= 4 && input.toString('latin1', 0, 4) === 'wOF2') {
    return Buffer.from(await loadWawoff2().decompress(input));
  }
  return input;
}

module.exports = { splitFont, toWoff2, toTtf };
