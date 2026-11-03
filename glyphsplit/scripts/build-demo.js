#!/usr/bin/env node
'use strict';
// Inlines dist/glyphsplit.bundle.js into demo/template.html -> demo/glyphsplit-demo.html
const fs = require('fs');
const path = require('path');
require('./build-bundle');
const bundle = fs.readFileSync(path.join(__dirname, '..', 'dist', 'glyphsplit.bundle.js'), 'utf8')
  .replace(/<\/script/gi, '<\\/script'); // a literal </script> would end the inline block
const tpl = fs.readFileSync(path.join(__dirname, '..', 'demo', 'template.html'), 'utf8');
const out = path.join(__dirname, '..', 'demo', 'glyphsplit-demo.html');
fs.writeFileSync(out, tpl.replace('/*__GLYPHSPLIT_BUNDLE__*/', () => bundle));
console.log(`${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
