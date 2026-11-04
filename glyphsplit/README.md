# glyphsplit (prototype)

Split a TrueType font into two files that are useless on their own, and put them back together only at render time in the browser. The goal: a downloaded web font does not open as a ready font in a font editor, and turning it into a desktop font for InDesign or other layout programs takes work glyph by glyph.

| File | Contains | Installed or opened on its own |
| --- | --- | --- |
| `<name>-metrics.js` | Advance widths, kerning, all OpenType features (GSUB, GPOS, GDEF, kern), cmap. **No outlines.** | Draws nothing |
| `<name>-glyphs.woff2` | All outlines with their hinting, **mirrored left/right at the centre of the colon, each glyph moved sideways by its own random distance**, scrambled advance widths, no layout tables, glyphs on scrambled private-use code points. | Typing gives nothing useful; in an editor every glyph sits somewhere else |

## Protection built in

| Measure | What it does |
| --- | --- |
| Embedding (`OS/2 fsType`) | Restricted licence embedding by default. Layout programs refuse or warn when embedding the font in PDFs. In our test, Chrome embedded it in a PDF only as drawings (Type 3), not as a font file. Browsers ignore the flag. |
| Copyright and licence | `--copyright`, `--license`, `--license-url` go into name IDs 0, 13 and 14 of both files. |
| ID in the PostScript name | `--id kunde42` gives `FontName-kunde42`. PDFs list the PostScript names of embedded fonts, so the ID shows up in every PDF made with the font. |
| Neutral names | `--uuid` replaces family and PostScript names with a random UUID (which then is the ID). |
| Fingerprint glyphs | Exact copies of a few letters, named after the copyright text in Adobe Glyph List form (`copyright_space_two_zero_two_six_...`). A contextual substitution puts them in place of the letter wherever neither neighbour is kerned with it, so spacing stays exactly the same. Text extraction that reads glyph names returns the copyright text. Whether a PDF shows it depends on the program that made the PDF. |
| Mirror and individual offsets | No single step restores the outlines; each glyph needs its own correction. `--no-mirror`, `--no-jitter`, `--jitter-em <n>` (default 0.5, capped at 0.5) |
| Composite glyphs | Kept as composites (e.g. ä = a + dieresis), with each component placement recalculated, so their hinting stays. `--resolve-composites` turns them into plain outlines, so the editor does not show their parts; their hinting is then dropped. |

## What stays intact

- **Hinting** of the glyph font: programs (`fpgm`, `prep`, `cvt`, `gasp`) and the instructions of every glyph are kept byte for byte. Only x coordinates change; the point order stays, so instructions still address the same points. Vertical hinting (baseline, x-height, cap height) is not affected by mirroring or moving sideways. The metrics font has no outlines, so it carries no hinting.
- **Vertical metrics** (`vhea`, `vmtx`) in both files, extended for the fingerprint glyphs.
- **Device tables:** `hdmx` and `LTSH` stay in the metrics font (extended for added glyphs). The glyph font drops them because its advance widths are scrambled. `VDMX` stays in both.

## How it works

1. The text block gets the metrics font. Its glyphs have no outlines, so the text is laid out exactly like the original but stays invisible. Line breaks, selection, links, underlines, find-in-page and screen readers all work on this layer.
2. Each word is shaped with [HarfBuzz](https://github.com/harfbuzz/harfbuzzjs) (WebAssembly) using the same metrics font, with the features and language of its element: `font-variant-caps`, `font-variant-ligatures`, `font-variant-numeric`, `font-feature-settings`, `font-kerning`, `lang`.
3. The resulting glyphs are drawn from the glyph font in an `aria-hidden` SVG, each at the position HarfBuzz gives, anchored where the browser put the word.

## Build the fonts

```bash
npm install
npx glyphsplit Brand.ttf --woff2 --copyright "© 2026 Your Name" --license "Web use on example.com only" --license-url "https://example.com/license" --id customer42
```

Writes `Brand-metrics.js` and `Brand-glyphs.woff2`. The metrics font is a script (base64), so pages also work when opened from disk (`file://`).

The input may be a TTF or a WOFF2 file (WOFF2 is decompressed first, which needs the optional `wawoff2` package).

## Use it

```html
<style>
  /* One @font-face per split font. The metrics families ("Brand Metrics") are registered by
     the generated scripts, so they cannot be declared here: the text block names them, or
     gets them prepended when it names none (see below). */
  @font-face { font-family: "Brand Glyphs"; src: url("Brand-glyphs.woff2") format("woff2"); font-display: block; }
</style>

<p data-glyphsplit>Kapitälchen, Ligaturen und Kerning: To Wa office</p>

<script src="dist/glyphsplit.bundle.js"></script>   <!-- client + HarfBuzz, 500 KB -->
<script src="Brand-metrics.js"></script>
<script>
  Glyphsplit.apply({ data: GLYPHSPLIT["Brand"], glyphFamily: "Brand Glyphs" });
</script>
```

Several fonts, for example two optical sizes, are passed as an array. Each text block is drawn by the font whose metrics family is named first in its `font-family`; a block that names none gets the first font in the list.

```css
.tt-text { font-family: "Brand Metrics", serif }
.tt-text.strong { font-family: "BrandStrong Metrics", serif }
```

```js
Glyphsplit.apply([
  { data: GLYPHSPLIT["Brand"],       glyphFamily: "Brand Glyphs" },
  { data: GLYPHSPLIT["BrandStrong"], glyphFamily: "BrandStrong Glyphs" }
]);
```

Build the bundle with `npm run bundle`. `npm run demo` builds `demo/glyphsplit-demo.html`, which expects `Guapisima-Black-metrics.js` and `Guapisima-Black-glyphs.woff2` (or `.ttf`) next to it.

## Test results (Chrome, FreeSerif Bold as test font)

- HarfBuzz gives identical positions with the metrics font and with the original, including ligatures, small caps with attached marks and oldstyle numerals. The only glyph changes are the fingerprint copies.
- After undoing mirror and offset, all 772 outlines of the glyph font match the original point for point: simple glyphs exactly, composites within half a unit (rounding of the component offset). Same for every combination of `--no-mirror` and `--no-jitter`.
- All glyph instructions are unchanged. FreeType with bytecode hinting: vertical position and height of the mirrored glyphs match the original in 165 of 170 samples (54 of 170 without hinting).
- Vertical metrics, `hdmx` and `LTSH` checked with a test font that has them.
- Both fonts pass Chrome's font sanitizer (OTS).
- 112 block comparisons against the original font at 8 window widths: no visible difference except one paragraph with superscript and subscript (see limits). Antialiasing differs slightly (mean 5 to 10 of 255 grey levels), because the glyph font has no hinting and mirrored glyphs are drawn flipped.
- Works with fonts beyond 6400 glyphs (codes move to the supplementary private-use plane).

## Limits

- **Prototype, tested in Chrome only.** The client compensates two rounding rules measured in Chrome: HTML text baselines are snapped to whole pixels, and the SVG box is placed on whole pixels. Firefox and Safari may round differently.
- **Lines that mix sizes** (`<sup>`, `<sub>`) can sit 1 px off at some widths.
- **The `lang` attribute matters.** Fonts can switch features per language (the test font has no ligatures for German). The client passes the nearest `lang` to HarfBuzz, like the browser does.
- **Underlines** run straight through descenders, because the metrics font has no outlines to leave gaps around.
- **Selected text** keeps its colour instead of the selection text colour.
- Not supported yet: right-to-left and vertical text, `text-transform: capitalize` follows a simple rule, `letter-spacing` is approximated.
- **TrueType only**, no variable fonts. Vertical metrics (`vhea`, `vmtx`) are removed.
- **Hinting in the browser:** Chrome on Linux renders the glyph font the same with and without hinting, so there it has no visible effect. Windows and macOS were not tested. Horizontal hinting can round differently on mirrored glyphs.
- **Contour direction** of mirrored glyphs is reversed (to keep the point order for hinting). All renderers that fill by the non-zero rule draw them correctly.
- **Fingerprint glyphs** only appear between letters that are not kerned with them. Fonts with a lot of kerning get few such places.
- **The browser needs the correction table** (mirror axis and offset per glyph) and ships it in the metrics script. The work this saves an attacker is real only for someone who does not read the script.
- **Protection:** neither file alone is a usable font. Anyone who collects both files can rebuild the original with a short script, because glyph ids match and the code table ships with the metrics font.

## License

MIT. The bundle includes HarfBuzz (MIT).
