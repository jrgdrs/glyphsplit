#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { splitFont, toWoff2 } = require('../src');

const HELP = `Usage: glyphsplit <font.ttf|font.woff2> [options]

Splits a TrueType font (TTF or WOFF2) into two files that are useless on their own:
  <name>-metrics.js    spacing, kerning and OpenType features, no outlines
                       (a script, so pages also work from file://)
  <name>-glyphs.ttf    outlines and hinting, mirrored at the centre of the colon, each glyph
                       moved by its own distance, scrambled spacing and codes
                       (.woff2 with --woff2)

Protection:
  --copyright <text>   Copyright text (name ID 0, fingerprint glyph names)
  --license <text>     Licence text (name ID 13)
  --license-url <url>  Licence URL (name ID 14)
  --id <text>          ID added to the PostScript name (default: random)
  --uuid               Replace family and PostScript names with a UUID
  --embedding <type>   OS/2 embedding: restricted (default), preview, editable, installable
  --no-fingerprint     No fingerprint glyphs
  --no-mirror          Do not mirror the outlines
  --no-jitter          Do not move glyphs by individual distances
  --jitter-em <n>      Largest individual distance in em (default: 0.5, capped at 0.5)
  --resolve-composites Turn composite glyphs (e.g. ä = a + dieresis) into plain
                       outlines, so the editor does not show their parts.
                       Their hinting is dropped.

Output:
  -o, --out <dir>      Output folder (default: next to the font)
  --name <name>        Name for the files and GLYPHSPLIT["<name>"] (default: file name)
  --woff2              Write the glyph font as WOFF2 (needs: npm install wawoff2)
  -h, --help           Show this help
`;

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`${v} needs a value`); return argv[++i]; };
    if (v === '-h' || v === '--help') a.help = true;
    else if (v === '-o' || v === '--out') a.out = val();
    else if (v === '--name') a.name = val();
    else if (v === '--woff2') a.woff2 = true;
    else if (v === '--copyright') a.copyright = val();
    else if (v === '--license') a.license = val();
    else if (v === '--license-url') a.licenseUrl = val();
    else if (v === '--id') a.id = val();
    else if (v === '--uuid') a.uuid = true;
    else if (v === '--embedding') a.embedding = val();
    else if (v === '--no-fingerprint') a.fingerprint = false;
    else if (v === '--no-mirror') a.mirror = false;
    else if (v === '--no-jitter') a.jitter = false;
    else if (v === '--jitter-em') a.jitterEm = parseFloat(val());
    else if (v === '--resolve-composites') a.resolveComposites = true;
    else if (!a.input) a.input = v;
    else throw new Error(`Unknown argument: ${v}`);
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) { process.stdout.write(HELP); process.exit(args.help ? 0 : 1); }
  const name = args.name || path.basename(args.input).replace(/\.[^.]+$/, '');
  const dir = args.out || path.dirname(args.input);
  fs.mkdirSync(dir, { recursive: true });

  const r = await splitFont(fs.readFileSync(args.input), args);
  r.warnings.forEach((w) => console.warn(`Note: ${w}`));
  const data = {
    family: name, unitsPerEm: r.unitsPerEm, axis: r.axis,
    codes: r.codes, offsets: r.offsets, metrics: r.metrics.toString('base64'),
  };
  const metricsOut = path.join(dir, `${name}-metrics.js`);
  fs.writeFileSync(metricsOut, `/* glyphsplit metrics font for "${name}" */\n(window.GLYPHSPLIT = window.GLYPHSPLIT || {})[${JSON.stringify(name)}] = ${JSON.stringify(data)};\n`);
  const glyphsOut = path.join(dir, `${name}-glyphs.${args.woff2 ? 'woff2' : 'ttf'}`);
  fs.writeFileSync(glyphsOut, args.woff2 ? await toWoff2(r.glyphs) : r.glyphs);

  console.log(`${r.numGlyphs} glyphs, ${r.unitsPerEm} units per em`);
  console.log(`ID: ${r.id}   PostScript name: ${r.postScriptName}`);
  if (r.axis !== null) console.log(`Mirrored at x = ${r.axis} (centre of the colon)`);
  if (r.fingerprint.length) console.log(`Fingerprint glyphs: ${r.fingerprint.map((f) => `${f.letter} -> ${f.glyphName}`).join(', ')}`);
  console.log(`Metrics font: ${metricsOut} (${(fs.statSync(metricsOut).size / 1024).toFixed(0)} KB)`);
  console.log(`Glyph font:   ${glyphsOut} (${(fs.statSync(glyphsOut).size / 1024).toFixed(0)} KB)`);
}

main().catch((e) => { console.error(`glyphsplit: ${e.message}`); process.exit(1); });
