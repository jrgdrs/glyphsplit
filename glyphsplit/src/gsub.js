'use strict';

/**
 * Adds one single-substitution lookup to a GSUB table and registers it under
 * the given feature tags in every script and language system.
 *
 * Offsets in GSUB are 16-bit and point forward, so the table cannot simply be
 * extended at the end. Instead new script, feature and lookup lists are written
 * in front of the original bytes. Every original lookup is reached through an
 * Extension lookup (32-bit offset) that points into the untouched original data.
 */

function u16(b, p) { return b.readUInt16BE(p); }

function coverage(gids) {
  const s = Array.from(new Set(gids)).sort((a, b) => a - b);
  const c = Buffer.alloc(4 + s.length * 2);
  c.writeUInt16BE(1, 0); c.writeUInt16BE(s.length, 2);
  s.forEach((g, i) => c.writeUInt16BE(g, 4 + i * 2));
  return c;
}

function parseGsub(g) {
  const sl = u16(g, 4), fl = u16(g, 6), ll = u16(g, 8);
  const scripts = [];
  for (let i = 0, n = u16(g, sl); i < n; i++) {
    const tag = g.toString('latin1', sl + 2 + i * 6, sl + 6 + i * 6);
    const st = sl + u16(g, sl + 6 + i * 6);
    const readLang = (p) => {
      const req = u16(g, p + 2), cnt = u16(g, p + 4);
      const feats = [];
      for (let k = 0; k < cnt; k++) feats.push(u16(g, p + 6 + k * 2));
      return { req, feats };
    };
    const dflOff = u16(g, st);
    const script = { tag, dfl: dflOff ? readLang(st + dflOff) : null, langs: [] };
    for (let j = 0, m = u16(g, st + 2); j < m; j++) {
      const ltag = g.toString('latin1', st + 4 + j * 6, st + 8 + j * 6);
      script.langs.push({ tag: ltag, ...readLang(st + u16(g, st + 8 + j * 6)) });
    }
    scripts.push(script);
  }
  const features = [];
  for (let i = 0, n = u16(g, fl); i < n; i++) {
    const tag = g.toString('latin1', fl + 2 + i * 6, fl + 6 + i * 6);
    const ft = fl + u16(g, fl + 6 + i * 6);
    const paramsOff = u16(g, ft);
    const lookups = [];
    for (let k = 0, m = u16(g, ft + 2); k < m; k++) lookups.push(u16(g, ft + 4 + k * 2));
    features.push({ tag, params: paramsOff ? ft + paramsOff : 0, lookups });
  }
  const lookups = [];
  for (let i = 0, n = u16(g, ll); i < n; i++) {
    const lk = ll + u16(g, ll + 2 + i * 2);
    const type = u16(g, lk), flag = u16(g, lk + 2), cnt = u16(g, lk + 4);
    const subs = [];
    for (let k = 0; k < cnt; k++) {
      const st = lk + u16(g, lk + 6 + k * 2);
      if (type === 7) subs.push({ type: u16(g, st + 2), abs: st + g.readUInt32BE(st + 4) });
      else subs.push({ type, abs: st });
    }
    const mfs = flag & 0x10 ? u16(g, lk + 6 + cnt * 2) : null;
    lookups.push({ type: type === 7 ? (subs[0] ? subs[0].type : 1) : type, flag, subs, mfs });
  }
  return { scripts, features, lookups };
}

class Out {
  constructor() { this.parts = []; this.size = 0; }
  at() { return this.size; }
  push(buf) { this.parts.push(buf); this.size += buf.length; return this.size - buf.length; }
  bytes() { return Buffer.concat(this.parts); }
}

/**
 * items: [{ from, to, prev: [gids], next: [gids] }]
 * Adds a single substitution (from -> to) that only fires between a glyph from
 * `prev` and a glyph from `next`, through a chaining context lookup registered
 * under featureTags.
 */
function addSubstitution(gsubBuf, items, featureTags) {
  const warnings = [];
  const g = gsubBuf || null;
  const parsed = g ? parseGsub(g) : { scripts: [], features: [], lookups: [] };
  const singleLookup = parsed.lookups.length;
  const newLookup = singleLookup + 1; // the chaining context lookup is the one features use

  // features: append the lookup to existing features with these tags, add new
  // features where a language system lacks the tag
  const features = parsed.features.map((f) => ({ ...f, lookups: f.lookups.slice() }));
  features.forEach((f) => { if (featureTags.includes(f.tag)) f.lookups.push(newLookup); });
  const created = {};
  const ensure = (tag) => {
    if (created[tag] === undefined) { created[tag] = features.length; features.push({ tag, params: 0, lookups: [newLookup] }); }
    return created[tag];
  };
  let scripts = parsed.scripts.map((s) => ({ ...s, langs: s.langs.map((l) => ({ ...l, feats: l.feats.slice() })), dfl: s.dfl ? { ...s.dfl, feats: s.dfl.feats.slice() } : null }));
  if (!scripts.length) scripts = [{ tag: 'DFLT', dfl: { req: 0xffff, feats: [] }, langs: [] }];
  const addTo = (ls) => {
    if (!ls) return;
    for (const tag of featureTags) if (!ls.feats.some((fi) => features[fi].tag === tag)) ls.feats.push(ensure(tag));
  };
  scripts.forEach((s) => { addTo(s.dfl); s.langs.forEach(addTo); });

  // sort features by tag (as the spec recommends) and remap indices
  const order = features.map((f, i) => i).sort((a, b) => (features[a].tag < features[b].tag ? -1 : features[a].tag > features[b].tag ? 1 : a - b));
  const remap = new Array(features.length);
  order.forEach((oldI, newI) => { remap[oldI] = newI; });
  const sortedFeatures = order.map((i) => features[i]);
  const fixLang = (ls) => { if (!ls) return; ls.feats = ls.feats.map((i) => remap[i]); if (ls.req !== 0xffff) ls.req = remap[ls.req]; };
  scripts.forEach((s) => { fixLang(s.dfl); s.langs.forEach(fixLang); });

  // ---- write the new front part ----
  const out = new Out();
  const header = Buffer.alloc(10);
  header.writeUInt32BE(0x00010000, 0);
  out.push(header);

  // ScriptList
  const slStart = out.at();
  const slHead = Buffer.alloc(2 + scripts.length * 6);
  slHead.writeUInt16BE(scripts.length, 0);
  out.push(slHead);
  scripts.forEach((s, i) => {
    const stStart = out.at();
    slHead.write(s.tag, 2 + i * 6, 4, 'latin1');
    slHead.writeUInt16BE(stStart - slStart, 6 + i * 6);
    const stHead = Buffer.alloc(4 + s.langs.length * 6);
    stHead.writeUInt16BE(s.langs.length, 2);
    out.push(stHead);
    const writeLang = (ls) => {
      const b = Buffer.alloc(6 + ls.feats.length * 2);
      b.writeUInt16BE(ls.req, 2); b.writeUInt16BE(ls.feats.length, 4);
      ls.feats.forEach((f, k) => b.writeUInt16BE(f, 6 + k * 2));
      return out.push(b) - stStart;
    };
    if (s.dfl) stHead.writeUInt16BE(writeLang(s.dfl), 0);
    s.langs.forEach((l, j) => {
      stHead.write(l.tag, 4 + j * 6, 4, 'latin1');
      stHead.writeUInt16BE(writeLang(l), 8 + j * 6);
    });
  });

  // FeatureList (params are re-pointed after the original bytes are placed)
  const flStart = out.at();
  const flHead = Buffer.alloc(2 + sortedFeatures.length * 6);
  flHead.writeUInt16BE(sortedFeatures.length, 0);
  out.push(flHead);
  const paramFixups = [];
  sortedFeatures.forEach((f, i) => {
    const b = Buffer.alloc(4 + f.lookups.length * 2);
    b.writeUInt16BE(f.lookups.length, 2);
    f.lookups.forEach((l, k) => b.writeUInt16BE(l, 4 + k * 2));
    const pos = out.push(b);
    flHead.write(f.tag, 2 + i * 6, 4, 'latin1');
    flHead.writeUInt16BE(pos - flStart, 6 + i * 6);
    if (f.params) paramFixups.push({ buf: b, pos, abs: f.params });
  });

  // LookupList: every original lookup becomes an Extension lookup
  const llStart = out.at();
  const llHead = Buffer.alloc(2 + (parsed.lookups.length + 2) * 2);
  llHead.writeUInt16BE(parsed.lookups.length + 2, 0);
  out.push(llHead);
  const extFixups = [];
  const setLookupOffset = (i, pos) => {
    if (pos - llStart > 0xffff) throw new Error('GSUB too large to extend (lookup list offset overflow).');
    llHead.writeUInt16BE(pos - llStart, 2 + i * 2);
  };
  parsed.lookups.forEach((lk, i) => {
    const b = Buffer.alloc(6 + lk.subs.length * 2 + (lk.mfs !== null ? 2 : 0));
    b.writeUInt16BE(7, 0); b.writeUInt16BE(lk.flag, 2); b.writeUInt16BE(lk.subs.length, 4);
    if (lk.mfs !== null) b.writeUInt16BE(lk.mfs, 6 + lk.subs.length * 2);
    const lpos = out.push(b);
    setLookupOffset(i, lpos);
    lk.subs.forEach((s, k) => {
      const ext = Buffer.alloc(8);
      ext.writeUInt16BE(1, 0); ext.writeUInt16BE(s.type, 2);
      const epos = out.push(ext);
      b.writeUInt16BE(epos - lpos, 6 + k * 2);
      extFixups.push({ buf: ext, pos: epos, abs: s.abs });
    });
  });
  // our lookup 1: single substitution, format 2 (only reached through lookup 2)
  const sorted = items.map((it) => [it.from, it.to]).sort((a, b) => a[0] - b[0]);
  const lk = Buffer.alloc(8);
  lk.writeUInt16BE(1, 0); lk.writeUInt16BE(0, 2); lk.writeUInt16BE(1, 4); lk.writeUInt16BE(8, 6);
  setLookupOffset(singleLookup, out.push(lk));
  const sub = Buffer.alloc(6 + sorted.length * 2);
  sub.writeUInt16BE(2, 0); sub.writeUInt16BE(sub.length, 2); sub.writeUInt16BE(sorted.length, 4);
  sorted.forEach(([, to], i) => sub.writeUInt16BE(to, 6 + i * 2));
  out.push(sub);
  out.push(coverage(sorted.map((p) => p[0])));

  // our lookup 2: chaining context, format 3, one subtable per letter
  const ctx = Buffer.alloc(6 + items.length * 2);
  ctx.writeUInt16BE(6, 0); ctx.writeUInt16BE(0, 2); ctx.writeUInt16BE(items.length, 4);
  const ctxPos = out.push(ctx);
  setLookupOffset(newLookup, ctxPos);
  items.forEach((it, i) => {
    const covs = [coverage(it.prev), coverage([it.from]), coverage(it.next)];
    const st = Buffer.alloc(2 + 2 + 2 + 2 + 2 + 2 + 2 + 2 + 4);
    let p = 0;
    st.writeUInt16BE(3, p); p += 2;
    const headLen = st.length;
    let covOff = headLen;
    const offs = covs.map((c) => { const o = covOff; covOff += c.length; return o; });
    st.writeUInt16BE(1, p); st.writeUInt16BE(offs[0], p + 2); p += 4; // backtrack
    st.writeUInt16BE(1, p); st.writeUInt16BE(offs[1], p + 2); p += 4; // input
    st.writeUInt16BE(1, p); st.writeUInt16BE(offs[2], p + 2); p += 4; // lookahead
    st.writeUInt16BE(1, p); st.writeUInt16BE(0, p + 2); st.writeUInt16BE(singleLookup, p + 4);
    const sPos = out.push(st);
    covs.forEach((c) => out.push(c));
    if (sPos - ctxPos > 0xffff) throw new Error('GSUB fingerprint lookup too large.');
    ctx.writeUInt16BE(sPos - ctxPos, 6 + i * 2);
  });

  header.writeUInt16BE(slStart, 4);
  header.writeUInt16BE(flStart, 6);
  header.writeUInt16BE(llStart, 8);

  // original bytes behind everything
  const base = out.at();
  if (g) out.push(Buffer.from(g));
  extFixups.forEach((f) => f.buf.writeUInt32BE(base + f.abs - f.pos, 4));
  paramFixups.forEach((f) => {
    const rel = base + f.abs - f.pos;
    if (rel > 0xffff) { warnings.push('A GSUB feature parameter table could not be kept.'); return; }
    f.buf.writeUInt16BE(rel, 0);
  });
  return { gsub: out.bytes(), warnings };
}

module.exports = { addSubstitution };
