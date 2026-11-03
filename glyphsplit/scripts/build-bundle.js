#!/usr/bin/env node
'use strict';
// Builds dist/glyphsplit.bundle.js: HarfBuzz (WebAssembly, embedded) + glyphsplit client.
// The WebAssembly is embedded as base64, so the bundle also works from file:// without fetch().
const fs = require('fs');
const path = require('path');
const hbDir = path.dirname(require.resolve('harfbuzzjs/package.json'));
const read = (p) => fs.readFileSync(p, 'utf8');
const wasm = fs.readFileSync(path.join(hbDir, 'hb.wasm')).toString('base64');
const parts = [
  '/*! glyphsplit bundle. Includes HarfBuzz (MIT, https://github.com/harfbuzz/harfbuzzjs) */',
  read(path.join(hbDir, 'hb.js')),
  read(path.join(hbDir, 'hbjs.js')),
  'window.GLYPHSPLIT_HB_WASM = "' + wasm + '";',
  read(path.join(__dirname, '..', 'client', 'glyphsplit.js')),
];
fs.mkdirSync(path.join(__dirname, '..', 'dist'), { recursive: true });
const out = path.join(__dirname, '..', 'dist', 'glyphsplit.bundle.js');
fs.writeFileSync(out, parts.join('\n;\n'));
console.log(`${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
