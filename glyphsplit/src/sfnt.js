'use strict';

/** Reading and writing sfnt containers plus a few small table builders. */

function readTables(buf) {
  const numTables = buf.readUInt16BE(4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const tag = buf.toString('latin1', rec, rec + 4);
    const off = buf.readUInt32BE(rec + 8), len = buf.readUInt32BE(rec + 12);
    tables[tag] = Buffer.from(buf.subarray(off, off + len));
  }
  return { sfntVersion: buf.readUInt32BE(0), tables };
}

function checksum(buf) {
  const padded = buf.length % 4 ? Buffer.concat([buf, Buffer.alloc(4 - (buf.length % 4))]) : buf;
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
  return sum;
}

function writeFont(sfntVersion, tables) {
  const tags = Object.keys(tables).sort();
  const n = tags.length;
  let es = 0;
  while (1 << (es + 1) <= n) es++;
  const sr = (1 << es) * 16;
  const header = Buffer.alloc(12 + n * 16);
  header.writeUInt32BE(sfntVersion, 0);
  header.writeUInt16BE(n, 4); header.writeUInt16BE(sr, 6); header.writeUInt16BE(es, 8); header.writeUInt16BE(n * 16 - sr, 10);
  tables.head.writeUInt32BE(0, 8);
  const chunks = [header];
  let offset = header.length;
  tags.forEach((tag, i) => {
    const data = tables[tag], rec = 12 + i * 16;
    header.write(tag, rec, 4, 'latin1');
    header.writeUInt32BE(checksum(data), rec + 4);
    header.writeUInt32BE(offset, rec + 8);
    header.writeUInt32BE(data.length, rec + 12);
    const pad = (4 - (data.length % 4)) % 4;
    chunks.push(data, Buffer.alloc(pad));
    offset += data.length + pad;
  });
  const font = Buffer.concat(chunks);
  const headOffset = header.readUInt32BE(12 + tags.indexOf('head') * 16 + 8);
  font.writeUInt32BE((0xb1b0afba - checksum(font)) >>> 0, headOffset + 8);
  return font;
}

function clone(tables) {
  const out = {};
  for (const k of Object.keys(tables)) out[k] = Buffer.from(tables[k]);
  return out;
}

// ---------- cmap ----------

function cmapFormat4(start, gids) {
  const segCount = gids.length ? 2 : 1;
  const len = 16 + segCount * 8 + gids.length * 2;
  const b = Buffer.alloc(len);
  b.writeUInt16BE(4, 0); b.writeUInt16BE(len, 2);
  b.writeUInt16BE(segCount * 2, 6);
  let es = 0;
  while (1 << (es + 1) <= segCount) es++;
  b.writeUInt16BE((1 << es) * 2, 8); b.writeUInt16BE(es, 10); b.writeUInt16BE(segCount * 2 - (1 << es) * 2, 12);
  const ends = 14, starts = ends + segCount * 2 + 2, deltas = starts + segCount * 2, ros = deltas + segCount * 2, arr = ros + segCount * 2;
  let s = 0;
  if (gids.length) {
    b.writeUInt16BE(start + gids.length - 1, ends); b.writeUInt16BE(start, starts);
    b.writeUInt16BE(segCount * 2, ros);
    gids.forEach((g, i) => b.writeUInt16BE(g, arr + i * 2));
    s = 1;
  }
  b.writeUInt16BE(0xffff, ends + s * 2); b.writeUInt16BE(0xffff, starts + s * 2);
  b.writeInt16BE(1, deltas + s * 2);
  return b;
}

function cmapFormat12(pairs) {
  const sorted = pairs.slice().sort((a, b) => a[0] - b[0]);
  const b = Buffer.alloc(16 + sorted.length * 12);
  b.writeUInt16BE(12, 0); b.writeUInt32BE(b.length, 4); b.writeUInt32BE(sorted.length, 12);
  sorted.forEach(([code, gid], i) => {
    const r = 16 + i * 12;
    b.writeUInt32BE(code, r); b.writeUInt32BE(code, r + 4); b.writeUInt32BE(gid, r + 8);
  });
  return b;
}

function buildCmap(subtables) {
  const head = Buffer.alloc(4 + subtables.length * 8);
  head.writeUInt16BE(subtables.length, 2);
  let off = head.length;
  subtables.forEach(([pid, eid, data], i) => {
    head.writeUInt16BE(pid, 4 + i * 8); head.writeUInt16BE(eid, 6 + i * 8); head.writeUInt32BE(off, 8 + i * 8);
    off += data.length;
  });
  return Buffer.concat([head, ...subtables.map((s) => s[2])]);
}

// ---------- post (version 2 with our own glyph names) ----------

function buildPost(oldPost, names) {
  const head = Buffer.from(oldPost.subarray(0, 32));
  head.writeUInt32BE(0x00020000, 0);
  const idx = Buffer.alloc(2 + names.length * 2);
  idx.writeUInt16BE(names.length, 0);
  const strings = [];
  let next = 258;
  names.forEach((n, i) => {
    if (n === '.notdef') { idx.writeUInt16BE(0, 2 + i * 2); return; }
    idx.writeUInt16BE(next++, 2 + i * 2);
    const s = Buffer.from(n, 'latin1');
    if (s.length > 255) throw new Error(`Glyph name too long: ${n}`);
    strings.push(Buffer.from([s.length]), s);
  });
  return Buffer.concat([head, idx, ...strings]);
}

// ---------- name ----------

function readNames(name) {
  const count = name.readUInt16BE(2), strOff = name.readUInt16BE(4);
  const recs = [];
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    const rec = {
      pid: name.readUInt16BE(r), eid: name.readUInt16BE(r + 2), lid: name.readUInt16BE(r + 4), nid: name.readUInt16BE(r + 6),
    };
    const len = name.readUInt16BE(r + 8), off = name.readUInt16BE(r + 10);
    rec.data = Buffer.from(name.subarray(strOff + off, strOff + off + len));
    recs.push(rec);
  }
  return recs;
}

function nameString(recs, nid) {
  const w = recs.find((r) => r.nid === nid && r.pid === 3);
  if (w) return Buffer.from(w.data).swap16().toString('utf16le');
  const m = recs.find((r) => r.nid === nid && r.pid === 1);
  return m ? m.data.toString('latin1') : '';
}

/** Replace the given name ids (string, or null to remove) and write a format 0 name table. */
function buildName(recs, replace) {
  const ids = Object.keys(replace).map(Number);
  const kept = recs.filter((r) => !ids.includes(r.nid));
  for (const nid of ids) {
    const v = replace[nid];
    if (v === null || v === undefined || v === '') continue;
    kept.push({ pid: 3, eid: 1, lid: 0x409, nid, data: Buffer.from(v, 'utf16le').swap16() });
  }
  kept.sort((a, b) => a.pid - b.pid || a.eid - b.eid || a.lid - b.lid || a.nid - b.nid);
  const head = Buffer.alloc(6 + kept.length * 12);
  head.writeUInt16BE(kept.length, 2);
  head.writeUInt16BE(head.length, 4);
  let off = 0;
  kept.forEach((r, i) => {
    const p = 6 + i * 12;
    head.writeUInt16BE(r.pid, p); head.writeUInt16BE(r.eid, p + 2); head.writeUInt16BE(r.lid, p + 4); head.writeUInt16BE(r.nid, p + 6);
    head.writeUInt16BE(r.data.length, p + 8); head.writeUInt16BE(off, p + 10);
    off += r.data.length;
  });
  return Buffer.concat([head, ...kept.map((r) => r.data)]);
}

module.exports = { readTables, writeFont, clone, cmapFormat4, cmapFormat12, buildCmap, buildPost, readNames, nameString, buildName };
