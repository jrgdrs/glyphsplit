/**
 * glyphsplit browser client (prototype)
 *
 *   <p data-glyphsplit>Kapitälchen und Ligaturen: office</p>
 *   <script src="glyphsplit.bundle.js"></script>        (client + HarfBuzz)
 *   <script src="Brand-metrics.js"></script>            (metrics font + code table)
 *   <script>
 *     Glyphsplit.apply({ data: GLYPHSPLIT["Brand"], glyphFamily: "Brand Glyphs" });
 *   </script>
 *
 * For more than one font, pass them together: fonts whose metrics family the element
 * already uses are drawn by the matching one, with the font-family order in the CSS
 * deciding which that is.
 *
 *   <script>
 *     Glyphsplit.apply([
 *       { data: GLYPHSPLIT["Brand"], glyphFamily: "Brand Glyphs" },
 *       { data: GLYPHSPLIT["BrandStrong"], glyphFamily: "BrandStrong Glyphs" }
 *     ]);
 *   </script>
 *
 * How it draws:
 *  1. The text block gets the metrics font. Its glyphs have no outlines, so the
 *     text is laid out exactly like the original but stays invisible. Selection,
 *     links, underlines, find-in-page and screen readers all work on this layer.
 *  2. Each word is shaped with HarfBuzz using the same metrics font and the CSS
 *     features of its element (small caps, ligatures, numerals, kerning ...).
 *  3. The resulting glyphs are drawn from the glyph font in an aria-hidden SVG,
 *     each at the position HarfBuzz gives, anchored where the browser put the word.
 */
(function (root) {
  'use strict';

  var CSS = [
    '.gsp-on{position:relative}',
    '.gsp-on{text-decoration-skip-ink:none}',
    '.gsp-svg{position:absolute;left:0;top:0;overflow:visible;pointer-events:none;-webkit-user-select:none;user-select:none}',
    '.gsp-svg text{white-space:pre;font-kerning:none;font-feature-settings:normal;font-synthesis:none;letter-spacing:0;word-spacing:0}'
  ].join('\n');
  var SVG_NS = 'http://www.w3.org/2000/svg';

  function b64ToBytes(b64) {
    var bin = atob(b64), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function firstFamily(cs) {
    return cs.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '');
  }

  // CSS font settings -> HarfBuzz feature string
  function featuresFor(cs) {
    var f = [];
    if (cs.fontKerning === 'none') f.push('kern=0');
    var lig = cs.fontVariantLigatures || 'normal';
    if (lig === 'none') f.push('liga=0', 'clig=0', 'calt=0', 'dlig=0');
    if (/no-common-ligatures/.test(lig)) f.push('liga=0', 'clig=0');
    if (/discretionary-ligatures/.test(lig) && !/no-discretionary/.test(lig)) f.push('dlig');
    if (/no-contextual/.test(lig)) f.push('calt=0');
    var caps = cs.fontVariantCaps || 'normal';
    if (caps === 'small-caps') f.push('smcp');
    if (caps === 'all-small-caps') f.push('smcp', 'c2sc');
    if (caps === 'petite-caps') f.push('pcap');
    if (caps === 'all-petite-caps') f.push('pcap', 'c2pc');
    var num = cs.fontVariantNumeric || 'normal';
    [['oldstyle-nums', 'onum'], ['lining-nums', 'lnum'], ['tabular-nums', 'tnum'], ['proportional-nums', 'pnum'],
     ['slashed-zero', 'zero'], ['diagonal-fractions', 'frac'], ['ordinal', 'ordn']].forEach(function (p) {
      if (num.indexOf(p[0]) >= 0) f.push(p[1]);
    });
    var ffs = cs.fontFeatureSettings;
    if (ffs && ffs !== 'normal') {
      ffs.split(',').forEach(function (item) {
        var m = item.trim().match(/^["'](\w{4})["']\s*(on|off|\d+)?$/);
        if (!m) return;
        var v = m[2] === undefined || m[2] === 'on' ? 1 : m[2] === 'off' ? 0 : parseInt(m[2], 10);
        f.push(m[1] + '=' + v);
      });
    }
    if (parseFloat(cs.letterSpacing)) f.push('liga=0', 'clig=0'); // browsers drop common ligatures when letters are spaced
    return f.join(',');
  }

  function transformText(text, tt) {
    if (tt === 'uppercase') return text.toUpperCase();
    if (tt === 'lowercase') return text.toLowerCase();
    if (tt === 'capitalize') return text.replace(/(^|\s)(\S)/g, function (_, s, c) { return s + c.toUpperCase(); });
    return text;
  }

  function Engine(hb, data) {
    var bytes = b64ToBytes(data.metrics);
    var blob = hb.createBlob(bytes);
    this.face = hb.createFace(blob, 0);
    this.font = hb.createFont(this.face);
    this.upem = this.face.upem;
    this.hb = hb;
    this.codes = data.codes;
    this.bytes = bytes;
    // glyph font transformation: mirrored at x = axis, then moved by offsets[gid] (font units)
    this.axis = typeof data.axis === 'number' ? data.axis : null;
    this.offsets = data.offsets || null;
  }
  Engine.prototype.shape = function (text, features, lang) {
    var buf = this.hb.createBuffer();
    buf.addText(text);
    // The language matters: fonts can switch features per language (e.g. no ligatures in German)
    if (lang) buf.setLanguage(lang);
    buf.guessSegmentProperties();
    this.hb.shape(this.font, buf, features);
    var out = buf.json();
    buf.destroy();
    return out;
  };

  // Distance from the top of a text box to its baseline, per font size
  var ascentCache = {};
  function ascentPx(rootEl, family, sizePx) {
    var key = family + '|' + sizePx;
    if (key in ascentCache) return ascentCache[key];
    var probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;line-height:normal;font-size:' + sizePx + 'px;font-family:"' + family + '"';
    probe.textContent = 'x';
    var mark = document.createElement('span');
    mark.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
    probe.appendChild(mark);
    rootEl.appendChild(probe);
    var r = document.createRange();
    r.setStart(probe.firstChild, 0); r.setEnd(probe.firstChild, 1);
    var rect = r.getClientRects()[0];
    // A text block inside a collapsed container has no layout box yet. Report a
    // placeholder and leave the result uncached, so it is measured once it is shown.
    if (!rect) { probe.remove(); return 0; }
    var v = mark.getBoundingClientRect().top - rect.top;
    probe.remove();
    return (ascentCache[key] = v);
  }

  function charCode(cp) { return String.fromCodePoint(cp); }

  function render(state) {
    var el = state.root, svg = state.svg, opts = state.opts;
    // an innerHTML reset drops the overlay; a contenteditable element has to keep it first
    if (!svg.isConnected) {
      if (el.isContentEditable) el.insertBefore(svg, el.firstChild);
      else el.appendChild(svg);
    }
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!el.clientWidth) { state.upToDate = false; return; } // no layout box (collapsed container)
    state.upToDate = true;
    // The font family of the text decides which of the registered fonts draws it: the one
    // whose metrics family comes first in the family list. A block whose text is switched
    // to another metrics font (a tester with two optical sizes) therefore changes hands
    // here as soon as the switch re-renders the block.
    var font = null;
    var list = fonts.map(function (f) { return f.opts.metricsFamily; });
    var walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) { return svg.contains(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; }
    });
    var node;
    while ((node = walk.nextNode())) {
      var pcs = getComputedStyle(node.parentElement);
      if (pcs.visibility === 'hidden' || pcs.display === 'none') continue;
      var naming = firstFamily(pcs);
      if (list.indexOf(naming) < 0) continue;
      font = fonts[list.indexOf(naming)];
      break;
    }
    if (!font) return;
    var eng = font.engine;
    svg.setAttribute('width', el.clientWidth);
    svg.setAttribute('height', el.clientHeight);
    var origin = svg.getBoundingClientRect();
    // The SVG box itself is painted at whole device pixels, HTML text is not:
    // take that rounding back out of every coordinate.
    var pr = window.devicePixelRatio || 1;
    var svgSnap = { x: Math.round(origin.left * pr) / pr - origin.left, y: Math.round(origin.top * pr) / pr - origin.top };
    var k0 = 1 / eng.upem;

    // The bounding rectangle is whole CSS pixels, so the ascent is re-measured per text
    // block and size. It is cached, but blocks are created at every stage of the load, the
    // first ones before any webfont has arrived; a wrong entry would then be reused by the
    // blocks added later. Each state therefore measures for itself once, not from the cache.
    if (!state.measured) {
      ascentCache = {};
      state.measured = true;
    }

    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) { return state.svg.contains(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; }
    });
    var node;
    while ((node = walker.nextNode())) {
      var parent = node.parentElement;
      var cs = getComputedStyle(parent);
      if (firstFamily(cs) !== font.opts.metricsFamily) continue; // other fonts draw themselves
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      var size = parseFloat(cs.fontSize);
      var k = size * k0;
      var features = featuresFor(cs);
      var spacing = parseFloat(cs.letterSpacing) || 0;
      var ascent = ascentPx(el, font.opts.metricsFamily, size);
      var fill = cs.color;
      var langEl = parent.closest('[lang]');
      var lang = langEl ? langEl.getAttribute('lang') : '';
      var data = node.data;
      var re = /\S+/g, m;
      while ((m = re.exec(data))) {
        drawRun(node, m.index, m.index + m[0].length);
      }
    }

    function drawRun(textNode, start, end) {
      var range = document.createRange();
      range.setStart(textNode, start); range.setEnd(textNode, end);
      var rects = range.getClientRects();
      if (!rects.length) return;
      if (rects.length > 1) {
        // the word is broken across lines: draw each line part on its own
        var cut = start + 1, top0 = charRect(textNode, start).top;
        while (cut < end && Math.abs(charRect(textNode, cut).top - top0) < 1) cut++;
        if (cut < end) { drawRun(textNode, start, cut); drawRun(textNode, cut, end); return; }
      }
      var text = transformText(textNode.data.slice(start, end), cs.textTransform);
      var glyphs = eng.shape(text, features, lang);
      var hasMissing = glyphs.some(function (g) { return g.g === 0; });
      var xs = [], ys = [], chars = '', gids = [];
      var baseX = rects[0].left - origin.left;
      // Browsers snap the baseline of HTML text to whole device pixels; SVG text is
      // not snapped, so it is done here to land on the same pixel row.
      var baseY = snap(rects[0].top + ascent, pr) - origin.top - svgSnap.y;
      var pen = 0, lastCluster = -1, clusterX = baseX;
      for (var i = 0; i < glyphs.length; i++) {
        var g = glyphs[i];
        if (hasMissing && g.cl !== lastCluster) {
          // a character the font lacks is drawn by a fallback font with other widths:
          // anchor every cluster where the browser put it
          clusterX = charRect(textNode, start + g.cl).left - origin.left;
          pen = 0;
        }
        if (g.cl !== lastCluster && lastCluster !== -1 && spacing) pen += spacing / k;
        lastCluster = g.cl;
        if (g.g !== 0) {
          xs.push((hasMissing ? clusterX : baseX) - svgSnap.x + (pen + g.dx) * k);
          ys.push(baseY - g.dy * k);
          chars += charCode(eng.codes[g.g]);
          gids.push(g.g);
        }
        pen += g.ax;
      }
      if (!chars) return;
      if (eng.axis !== null || eng.offsets) {
        // Every glyph needs its own correction: one <text> per glyph.
        // Mirrored outline point x' = 2*axis - x + offset, so draw it flipped (scale -1)
        // with the origin moved by (2*axis + offset); unmirrored: moved back by offset.
        var grp = document.createElementNS(SVG_NS, 'g');
        grp.setAttribute('font-family', '"' + font.opts.glyphFamily + '"');
        grp.setAttribute('font-size', size);
        grp.setAttribute('fill', fill);
        var cps = Array.from(chars);
        gids.forEach(function (gid, n) {
          var off = eng.offsets ? eng.offsets[gid] : 0;
          var te = document.createElementNS(SVG_NS, 'text');
          if (eng.axis !== null) {
            te.setAttribute('transform', 'matrix(-1 0 0 1 ' + round(xs[n] + k * (2 * eng.axis + off)) + ' ' + round(ys[n]) + ')');
          } else {
            te.setAttribute('x', round(xs[n] - k * off));
            te.setAttribute('y', round(ys[n]));
          }
          te.textContent = cps[n];
          grp.appendChild(te);
        });
        svg.appendChild(grp);
        return;
      }
      var t = document.createElementNS(SVG_NS, 'text');
      t.setAttribute('x', xs.map(round).join(' '));
      t.setAttribute('y', ys.map(round).join(' '));
      t.setAttribute('font-family', '"' + font.opts.glyphFamily + '"');
      t.setAttribute('font-size', size);
      t.setAttribute('fill', fill);
      t.textContent = chars;
      svg.appendChild(t);
    }
  }

  function round(v) { return Math.round(v * 100) / 100; }
  function snap(v, pr) { return Math.round(v * pr) / pr; }

  function charRect(textNode, i) {
    var r = document.createRange();
    r.setStart(textNode, i); r.setEnd(textNode, Math.min(i + 1, textNode.data.length));
    return r.getClientRects()[0] || r.getBoundingClientRect();
  }

  var states = [];
  // Every font registered through apply(), in the order it was passed: the family lists in
  // render() and the CSS are read against this.
  var fonts = [];
  var pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () { pending = false; states.forEach(render); });
  }

  /**
   * The metrics font is baked into each block's font-family as the first entry, so the
   * metrics scripts have to be loaded before this runs.
   *
   * @param {object|object[]} options          one entry per split font, or a single entry
   * @param {object} options.data              GLYPHSPLIT["Name"] from the generated <name>-metrics.js
   * @param {string} options.glyphFamily       font-family of the glyph font (@font-face in your CSS)
   * @param {string} [options.selector='[data-glyphsplit]']
   * @returns {Promise<number>} number of text blocks set up
   */
  function apply(options) {
    var list = Array.isArray(options) ? options : [options];
    var setup = list.map(function (options) {
      var data = options.data;
      if (!data || !data.metrics) throw new Error('glyphsplit: options.data is missing. Load <name>-metrics.js first.');
      return {
        data: data,
        opts: {
          glyphFamily: options.glyphFamily,
          metricsFamily: data.family + ' Metrics',
          selector: options.selector || '[data-glyphsplit]'
        }
      };
    });
    if (!document.getElementById('glyphsplit-style')) {
      var st = document.createElement('style');
      st.id = 'glyphsplit-style';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    var hbReady = root.createHarfBuzz({ wasmBinary: b64ToBytes(root.GLYPHSPLIT_HB_WASM) }).then(function (inst) { return root.hbjs(inst); });
    var jobs = setup.map(function (s) {
      var face = new FontFace(s.opts.metricsFamily, b64ToBytes(s.data.metrics));
      document.fonts.add(face);
      return Promise.all([face.load(), document.fonts.load('16px "' + s.opts.glyphFamily + '"')]).then(function (res) {
        if (!res[1].length) throw new Error('glyphsplit: glyph font "' + s.opts.glyphFamily + '" not found.');
        s.face = face;
      });
    });
    return Promise.all([hbReady].concat(jobs)).then(function (res) {
      var added = setup.map(function (s) {
        return { engine: new Engine(res[0], s.data), opts: s.opts };
      });
      added.forEach(function (f) { fonts.push(f); });
      var ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
      window.addEventListener('resize', schedule);
      // A block is set up once, for the first registered font that claims it. Which font
      // draws it is decided per render from the family list, so a block that is switched
      // between two metrics fonts later needs no second overlay.
      var els = [];
      added.forEach(function (font) {
        Array.from(document.querySelectorAll(font.opts.selector)).forEach(function (el) {
          if (els.indexOf(el) < 0) els.push(el);
        });
      });
      els.forEach(function (el) {
        // The metrics fonts exist only as bytes inside the generated <name>-metrics.js, so
        // the page names them in its CSS and one of them is the first family here. That
        // first family is what render() reads to pick the matching glyph font, and what the
        // block is laid out with. A block whose CSS names none of them gets the first
        // registered one prepended, so it works without any CSS of its own.
        var cs = getComputedStyle(el);
        var first = firstFamily(cs);
        var font = null;
        fonts.some(function (f) { if (f.opts.metricsFamily === first) { font = f; return true; } return false; });
        if (!font) {
          font = fonts[0];
          el.style.fontFamily = '"' + font.opts.metricsFamily + '", ' + cs.fontFamily;
        }
        el.classList.add('gsp-on');
        var svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('class', 'gsp-svg');
        svg.setAttribute('aria-hidden', 'true');
        // A contenteditable element adds an empty line box after a trailing block-level
        // child, which would make the block one line taller. As first child it does not,
        // and the drawing does not depend on the order of the element's children.
        if (el.isContentEditable) el.insertBefore(svg, el.firstChild);
        else el.appendChild(svg);
        var state = { root: el, svg: svg, upToDate: false };
        states.push(state);
        if (ro) ro.observe(el);
      });
      states.forEach(render);
      watchHidden();
      // The layout can still settle after this pass (a webfont arriving, different line
      // breaks), which moves the words away from the boxes drawn here. One more pass on the
      // next frame, one when all fonts are ready and one shortly after keep the outlines on
      // their text without watching layout continuously.
      refreshSoon();
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(refreshSoon);
      setTimeout(refreshSoon, 400);
      return els.length;
    });
  }

  var refreshQueued = false;
  function refreshSoon() {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(function () { refreshQueued = false; refresh(); });
  }

  // A container that is collapsed at load (a display:none fold, for example) gives its text
  // blocks no layout box, so they cannot be measured yet. It is opened again by toggling a
  // class above them, so class changes are watched and the pending blocks are drawn as soon
  // as they have a box. A block that loses its box is marked pending and drawn on reopen.
  var watching = false;
  function watchHidden() {
    if (watching || typeof MutationObserver !== 'function') return;
    watching = true;
    var pending = false;
    new MutationObserver(function () {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () {
        pending = false;
        states.forEach(function (s) { if (!s.upToDate && s.root.clientWidth) render(s); });
      });
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'hidden'], subtree: true });
  }

  function refresh() { states.forEach(render); }

  /** For demos: the glyph-font characters for a text, without positions. */
  function glyphCodes(text, features, lang) {
    if (!states.length) return '';
    var eng = fonts[0].engine;
    return eng.shape(text, features || '', lang || document.documentElement.lang).filter(function (g) { return g.g; })
      .map(function (g) { return charCode(eng.codes[g.g]); }).join('');
  }

  root.Glyphsplit = { apply: apply, refresh: refresh, glyphCodes: glyphCodes };
})(typeof window !== 'undefined' ? window : this);
