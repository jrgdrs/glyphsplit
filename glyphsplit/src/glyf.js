'use strict';

/**
 * TrueType outline helpers: decode simple and composite glyphs, resolve
 * composites into plain contours, and encode simple glyphs again.
 * A contour is an array of points [x, y, onCurve].
 */

const ARG_WORDS = 0x0001, ARGS_XY = 0x0002, HAS_SCALE = 0x0008, MORE = 0x0020,
  XY_SCALE = 0x0040, TWO_BY_TWO = 0x0080, SCALED_OFFSET = 0x0800;

function f2dot14(buf, pos) { return buf.readInt16BE(pos) / 16384; }

function decodeSimple(g) {
  const n = g.readInt16BE(0);
  let p = 10;
  const endPts = [];
  for (let i = 0; i < n; i++, p += 2) endPts.push(g.readUInt16BE(p));
  const numPoints = n ? endPts[n - 1] + 1 : 0;
  const insLen = g.readUInt16BE(p);
  let q = p + 2 + insLen;
  const flags = [];
  while (flags.length < numPoints) {
    const f = g[q++];
    flags.push(f);
    if (f & 0x08) { const rep = g[q++]; for (let r = 0; r < rep; r++) flags.push(f); }
  }
  const xs = [], ys = [];
  let v = 0;
  for (const f of flags) {
    if (f & 0x02) { const d = g[q++]; v += f & 0x10 ? d : -d; }
    else if (!(f & 0x10)) { v += g.readInt16BE(q); q += 2; }
    xs.push(v);
  }
  v = 0;
  for (const f of flags) {
    if (f & 0x04) { const d = g[q++]; v += f & 0x20 ? d : -d; }
    else if (!(f & 0x20)) { v += g.readInt16BE(q); q += 2; }
    ys.push(v);
  }
  const contours = [];
  let start = 0;
  for (const end of endPts) {
    const c = [];
    for (let i = start; i <= end; i++) c.push([xs[i], ys[i], (flags[i] & 1) === 1]);
    contours.push(c);
    start = end + 1;
  }
  return contours;
}

function decodeComposite(g) {
  const comps = [];
  let p = 10, flags;
  do {
    flags = g.readUInt16BE(p);
    const c = { flags, glyph: g.readUInt16BE(p + 2) };
    p += 4;
    if (flags & ARG_WORDS) {
      c.a1 = flags & ARGS_XY ? g.readInt16BE(p) : g.readUInt16BE(p);
      c.a2 = flags & ARGS_XY ? g.readInt16BE(p + 2) : g.readUInt16BE(p + 2);
      p += 4;
    } else {
      c.a1 = flags & ARGS_XY ? g.readInt8(p) : g.readUInt8(p);
      c.a2 = flags & ARGS_XY ? g.readInt8(p + 1) : g.readUInt8(p + 1);
      p += 2;
    }
    // x' = xx*x + yx*y, y' = xy*x + yy*y  (file order for 2x2: xx, xy, yx, yy)
    c.m = { xx: 1, xy: 0, yx: 0, yy: 1 };
    if (flags & HAS_SCALE) { const s = f2dot14(g, p); c.m = { xx: s, xy: 0, yx: 0, yy: s }; p += 2; }
    else if (flags & XY_SCALE) { c.m = { xx: f2dot14(g, p), xy: 0, yx: 0, yy: f2dot14(g, p + 2) }; p += 4; }
    else if (flags & TWO_BY_TWO) { c.m = { xx: f2dot14(g, p), xy: f2dot14(g, p + 2), yx: f2dot14(g, p + 4), yy: f2dot14(g, p + 6) }; p += 8; }
    comps.push(c);
  } while (flags & MORE);
  return comps;
}

/**
 * Returns a function gid -> contours with every composite resolved into plain
 * contours (coordinates rounded to whole units).
 */
function outlineReader(glyf, loca, numGlyphs) {
  const cache = new Map();
  const raw = (i) => glyf.subarray(loca[i], loca[i + 1]);

  function read(i, depth) {
    if (cache.has(i)) return cache.get(i);
    if (i >= numGlyphs || depth > 16) return [];
    const g = raw(i);
    let out;
    if (g.length === 0) out = [];
    else if (g.readInt16BE(0) >= 0) out = decodeSimple(g);
    else {
      out = [];
      for (const c of decodeComposite(g)) {
        const child = read(c.glyph, depth + 1);
        const m = c.m;
        const moved = child.map((ct) => ct.map(([x, y, on]) => [m.xx * x + m.yx * y, m.xy * x + m.yy * y, on]));
        let dx, dy;
        if (c.flags & ARGS_XY) {
          dx = c.a1; dy = c.a2;
          if (c.flags & SCALED_OFFSET) { const ox = dx, oy = dy; dx = m.xx * ox + m.yx * oy; dy = m.xy * ox + m.yy * oy; }
        } else {
          // point matching: parent point a1 meets child point a2
          const parentPts = out.flat(), childPts = moved.flat();
          const pp = parentPts[c.a1], cp = childPts[c.a2];
          dx = pp && cp ? pp[0] - cp[0] : 0;
          dy = pp && cp ? pp[1] - cp[1] : 0;
        }
        for (const ct of moved) out.push(ct.map(([x, y, on]) => [Math.round(x + dx), Math.round(y + dy), on]));
      }
    }
    cache.set(i, out);
    return out;
  }
  return (i) => read(i, 0);
}

/** Encode contours as a simple glyph without instructions. */
function encodeSimple(contours, overlap) {
  const pts = contours.flat();
  const endPts = [];
  let n = 0;
  for (const c of contours) { n += c.length; endPts.push(n - 1); }
  if (!pts.length) return { data: Buffer.alloc(0), bbox: null };
  const fl = [], xb = [], yb = [];
  let px = 0, py = 0;
  pts.forEach(([x, y, on], i) => {
    let f = on ? 1 : 0;
    if (i === 0 && overlap) f |= 0x40;
    const dx = x - px, dy = y - py;
    px = x; py = y;
    if (dx === 0) f |= 0x10;
    else if (dx >= -255 && dx <= 255) { f |= 0x02; if (dx > 0) f |= 0x10; xb.push(Math.abs(dx)); }
    else xb.push((dx >> 8) & 0xff, dx & 0xff);
    if (dy === 0) f |= 0x20;
    else if (dy >= -255 && dy <= 255) { f |= 0x04; if (dy > 0) f |= 0x20; yb.push(Math.abs(dy)); }
    else yb.push((dy >> 8) & 0xff, dy & 0xff);
    fl.push(f);
  });
  const fOut = [];
  for (let i = 0; i < fl.length; ) {
    let run = 1;
    while (i + run < fl.length && fl[i + run] === fl[i] && run < 256) run++;
    if (run > 1) { fOut.push(fl[i] | 0x08, run - 1); i += run; } else { fOut.push(fl[i]); i++; }
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  for (const v of [x0, y0, x1, y1]) if (v < -32768 || v > 32767) throw new Error('Glyph coordinates out of range after transformation.');
  const head = Buffer.alloc(10 + endPts.length * 2 + 2);
  head.writeInt16BE(endPts.length, 0);
  head.writeInt16BE(x0, 2); head.writeInt16BE(y0, 4); head.writeInt16BE(x1, 6); head.writeInt16BE(y1, 8);
  endPts.forEach((e, i) => head.writeUInt16BE(e, 10 + i * 2));
  head.writeUInt16BE(0, 10 + endPts.length * 2); // no instructions
  return { data: Buffer.concat([head, Buffer.from(fOut), Buffer.from(xb), Buffer.from(yb)]), bbox: [x0, y0, x1, y1], points: pts.length, contours: contours.length };
}

function bboxOf(contours) {
  const pts = contours.flat();
  if (!pts.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0, y0, x1, y1];
}

/** Mirror left/right at x = axis and keep the contour direction (reverse point order). */
function mirror(contours, axis) {
  return contours.map((c) => {
    const m = c.map(([x, y, on]) => [2 * axis - x, y, on]);
    return [m[0]].concat(m.slice(1).reverse());
  });
}

function shiftX(contours, dx) {
  return contours.map((c) => c.map(([x, y, on]) => [x + dx, y, on]));
}

// ---------- transformation that keeps hinting and composites ----------

const USE_MY_METRICS = 0x0200, UNSCALED_OFFSET = 0x1000, HAS_INSTR = 0x0100;

function f2(v) {
  const r = Math.round(v * 16384);
  return Math.max(-32768, Math.min(32767, r));
}

/**
 * Transform one glyph in place of x: x' = m*x + T  (m = -1 mirrors, T includes the axis and offset).
 * Point order, flags and instructions of simple glyphs stay as they are, so the
 * hinting program still addresses the same points. Composites stay composites:
 * each component already carries its own transformation (Tk), so the placement
 * is recomputed and the component matrix is mirrored as well.
 *
 * @param {Buffer} g        original glyph data
 * @param {number} m        1 or -1
 * @param {number} T        x translation of this glyph (font units)
 * @param {(gid)=>number} Tof  x translation of another glyph
 * @param {(gid)=>number[]} bboxOf  original bbox of a resolved glyph, for composites
 */
function transformGlyph(g, m, T, Tof, resolvedBbox) {
  if (g.length === 0) return { data: Buffer.alloc(0), bbox: null };
  const tx = (x) => m * x + T;
  if (g.readInt16BE(0) >= 0) {
    // ---- simple glyph: rewrite x coordinates only ----
    const n = g.readInt16BE(0);
    let p = 10;
    const endPts = [];
    for (let i = 0; i < n; i++, p += 2) endPts.push(g.readUInt16BE(p));
    const numPoints = n ? endPts[n - 1] + 1 : 0;
    const insLen = g.readUInt16BE(p);
    const headEnd = p + 2 + insLen;
    let q = headEnd;
    const flags = [];
    while (flags.length < numPoints) {
      const f = g[q++];
      flags.push(f);
      if (f & 0x08) { const rep = g[q++]; for (let r = 0; r < rep; r++) flags.push(f); }
    }
    const xs = [];
    let v = 0;
    for (const f of flags) {
      if (f & 0x02) { const d = g[q++]; v += f & 0x10 ? d : -d; }
      else if (!(f & 0x10)) { v += g.readInt16BE(q); q += 2; }
      xs.push(v);
    }
    const yStart = q;
    for (const f of flags) q += f & 0x04 ? 1 : f & 0x20 ? 0 : 2;
    const yBytes = g.subarray(yStart, q);
    const nx = xs.map(tx);
    const fl = [], xb = [];
    let prev = 0;
    nx.forEach((x, i) => {
      let f = flags[i] & ~(0x02 | 0x10 | 0x08);
      const d = x - prev; prev = x;
      if (d === 0) f |= 0x10;
      else if (d >= -255 && d <= 255) { f |= 0x02; if (d > 0) f |= 0x10; xb.push(Math.abs(d)); }
      else xb.push((d >> 8) & 0xff, d & 0xff);
      fl.push(f);
    });
    const fOut = [];
    for (let i = 0; i < fl.length; ) {
      let run = 1;
      while (i + run < fl.length && fl[i + run] === fl[i] && run < 256) run++;
      if (run > 1) { fOut.push(fl[i] | 0x08, run - 1); i += run; } else { fOut.push(fl[i]); i++; }
    }
    const out = Buffer.concat([Buffer.from(g.subarray(0, headEnd)), Buffer.from(fOut), Buffer.from(xb), Buffer.from(yBytes)]);
    if (numPoints) {
      const x0 = Math.min(...nx), x1 = Math.max(...nx);
      if (x0 < -32768 || x1 > 32767) throw new Error('Glyph coordinates out of range after transformation.');
      out.writeInt16BE(x0, 2); out.writeInt16BE(x1, 6);
    }
    return { data: out, bbox: numPoints ? [out.readInt16BE(2), out.readInt16BE(4), out.readInt16BE(6), out.readInt16BE(8)] : null };
  }
  // ---- composite glyph ----
  const parts = [Buffer.from(g.subarray(0, 10))];
  let p = 10, flags;
  do {
    flags = g.readUInt16BE(p);
    const glyph = g.readUInt16BE(p + 2);
    p += 4;
    let a1, a2;
    if (flags & ARG_WORDS) {
      a1 = flags & ARGS_XY ? g.readInt16BE(p) : g.readUInt16BE(p);
      a2 = flags & ARGS_XY ? g.readInt16BE(p + 2) : g.readUInt16BE(p + 2);
      p += 4;
    } else {
      a1 = flags & ARGS_XY ? g.readInt8(p) : g.readUInt8(p);
      a2 = flags & ARGS_XY ? g.readInt8(p + 1) : g.readUInt8(p + 1);
      p += 2;
    }
    let xx = 1, xy = 0, yx = 0, yy = 1, kind = 0;
    if (flags & HAS_SCALE) { xx = yy = f2dot14(g, p); p += 2; kind = 1; }
    else if (flags & XY_SCALE) { xx = f2dot14(g, p); yy = f2dot14(g, p + 2); p += 4; kind = 2; }
    else if (flags & TWO_BY_TWO) { xx = f2dot14(g, p); xy = f2dot14(g, p + 2); yx = f2dot14(g, p + 4); yy = f2dot14(g, p + 6); p += 8; kind = 3; }
    // Mirrored matrix: S*M*S with S = diag(m, 1) flips the off-diagonal terms
    const nxy = m * xy, nyx = m * yx;
    let nflags = (flags | ARG_WORDS) & ~USE_MY_METRICS; // advance widths are scrambled anyway
    if (flags & ARGS_XY) {
      let dx = a1, dy = a2;
      if (flags & SCALED_OFFSET) { const ox = dx, oy = dy; dx = xx * ox + yx * oy; dy = xy * ox + yy * oy; nflags = (nflags & ~SCALED_OFFSET) | UNSCALED_OFFSET; }
      // new point = S(M x + d) + (T,0), component stored as S x + (Tk,0)
      const Tk = Tof(glyph);
      a1 = Math.round(m * dx + T - xx * Tk);
      a2 = Math.round(dy - nxy * Tk);
      if (a1 < -32768 || a1 > 32767 || a2 < -32768 || a2 > 32767) throw new Error('Component offset out of range after transformation.');
    }
    // point-matched components (no ARGS_XY) line up by themselves: all points moved consistently
    const rec = Buffer.alloc(8);
    rec.writeUInt16BE(nflags, 0); rec.writeUInt16BE(glyph, 2);
    if (flags & ARGS_XY) { rec.writeInt16BE(a1, 4); rec.writeInt16BE(a2, 6); }
    else { rec.writeUInt16BE(a1, 4); rec.writeUInt16BE(a2, 6); }
    let tr = Buffer.alloc(0);
    if (kind === 1) { tr = Buffer.alloc(2); tr.writeInt16BE(f2(xx), 0); }
    else if (kind === 2) { tr = Buffer.alloc(4); tr.writeInt16BE(f2(xx), 0); tr.writeInt16BE(f2(yy), 2); }
    else if (kind === 3) { tr = Buffer.alloc(8); tr.writeInt16BE(f2(xx), 0); tr.writeInt16BE(f2(nxy), 2); tr.writeInt16BE(f2(nyx), 4); tr.writeInt16BE(f2(yy), 6); }
    parts.push(rec, tr);
  } while (flags & MORE);
  if (flags & HAS_INSTR) parts.push(Buffer.from(g.subarray(p, p + 2 + g.readUInt16BE(p))));
  const out = Buffer.concat(parts);
  const bb = resolvedBbox();
  if (bb) {
    const xa = tx(bb[0]), xb2 = tx(bb[2]);
    out.writeInt16BE(Math.min(xa, xb2), 2); out.writeInt16BE(bb[1], 4);
    out.writeInt16BE(Math.max(xa, xb2), 6); out.writeInt16BE(bb[3], 8);
  }
  return { data: out, bbox: bb ? [out.readInt16BE(2), out.readInt16BE(4), out.readInt16BE(6), out.readInt16BE(8)] : null };
}

function readLoca(head, locaTable, numGlyphs) {
  const long = head.readInt16BE(50) === 1;
  const loca = [];
  for (let i = 0; i <= numGlyphs; i++) loca.push(long ? locaTable.readUInt32BE(i * 4) : locaTable.readUInt16BE(i * 2) * 2);
  return loca;
}

module.exports = { outlineReader, encodeSimple, bboxOf, mirror, shiftX, readLoca, transformGlyph };
