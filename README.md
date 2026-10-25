# pixelmatch-triage

A pixel comparison library that reports **what changed**, not just **how many pixels changed**.

`pixelmatch-triage` is a derivative of [pixelmatch](https://github.com/mapbox/pixelmatch) (ISC,
Mapbox). It keeps the upstream comparison core — the same anti-aliasing detector, the same OKLab
HyAB perceptual distance, the same return value and error messages — and adds an opt-in layer that
turns a pixel count into a triage report:

- **Regions.** Neighbouring differing pixels are grouped into connected regions, each with a
  bounding box, pixel count, density, mean colour distance, colour samples and an
  `added` / `removed` / `mixed` classification, ranked by visual weight.
- **Shift report.** A whole-image integer translation between the two screenshots is estimated
  and reported, and can optionally be compensated for before comparison.
- **Quantitative metrics.** PSNR over the non-ignored pixels, a diff ratio, and anti-aliased /
  ignored pixel tallies.
- **Annotated diff.** The diff image can be returned with numbered boxes drawn around every
  region, without adding a dependency.
- **CLI + JSON.** A command-line tool that writes diff PNG, annotated PNG and a machine-readable
  JSON report, keeping upstream's exit codes.

```js
import {compare} from 'pixelmatch-triage/triage';

const result = compare(img1, img2, width, height, {threshold: 0.05});
console.log(result.diffPixels, result.psnr, result.regions.length);
// [
//   {id: 1, x: 420, y: 103, width: 16, height: 14, pixels: 129, meanDelta: 0.345, kind: 'mixed', ...}
// ]
```

The original API is still there, unchanged:

```js
import pixelmatch from 'pixelmatch-triage';
const numDiffPixels = pixelmatch(img1, img2, diff, width, height, {threshold: 0.1});
```

## Why this exists

Upstream deliberately stops at a single number. Its maintainer has closed several requests for
more by declaring them out of scope:

| Upstream issue | Request | Maintainer's answer |
| --- | --- | --- |
| [#81](https://github.com/mapbox/pixelmatch/issues/81) | "detect x number of areas that differ" | "No, it's only for direct 1-1 comparison." |
| [#94](https://github.com/mapbox/pixelmatch/issues/94) | return the differing pixels, not just the count | "Exposing an API with an array of pixels and diffs seems cumbersome and not satisfying a common need." |
| [#129](https://github.com/mapbox/pixelmatch/issues/129) | group differences / index them | "You could apply a density-based clustering algorithm such as DBSCAN… However, this is out of scope for this library." |
| [#133](https://github.com/mapbox/pixelmatch/issues/133) | a quantitative metric such as SSE/PSNR | open, unanswered |
| [#107](https://github.com/mapbox/pixelmatch/issues/107) | handle browser font-rendering offsets | open, unanswered |

That scope decision is sound for a library that wants to stay a few hundred lines and dependency
free, and this fork does not argue with it. But it leaves a real gap for the people who actually
run these comparisons: a CI job that fails with `36563` tells a reviewer nothing about whether the
change is a moved button or a rendering artefact.

`windowSize` (added upstream in 7.2) narrows the gap by reporting the worst N×N window instead of
the total, which filters scattered noise. It still returns one number, and it cannot say where or
what the change was. This fork keeps `windowSize` working and adds the missing layer on top.

### Measured illustration

`node examples/scenario.mjs` builds two regression cases against the same baseline:

```
A  primary button moved 140 px   (one intended change)
  pixels differing (upstream)   5400
  regions after merging         2
  solid / diffuse regions       2 / 0
  largest region                90x30 at (24,260), 2700 px, mean Δ0.708

B  faint specks over a 220x100 field   (no intended change)
  pixels differing (upstream)   2516
  regions after merging         1
  solid / diffuse regions       0 / 1
  largest region                220x100 at (20,80), 2516 px, mean Δ0.121
```

The upstream number is a volume. The region report adds the shape: case A is 100%-dense blocks
with a strong colour distance, case B is a few-percent-dense field of weak specks. Those two
want different reactions, and only one of them involves a human looking at a screenshot.

## Install

```bash
npm install pixelmatch-triage
```

Node 18+ (the code is plain ESM with no build step; the test suite uses `node --test`).

From a checkout:

```bash
git clone <this repo> pixelmatch-triage
cd pixelmatch-triage
npm ci
npm test
```

## API

### `compare(img1, img2, width, height[, options])`

Returns a report; it never writes into `img1` / `img2`.

| Option | Default | Meaning |
| --- | --- | --- |
| `threshold` | `0.1` | Upstream per-pixel threshold (OKLab HyAB, `1` = black vs white). |
| `includeAA` | `false` | Count anti-aliased pixels as differences. |
| `checkerboard` | `true` | Upstream handling of semi-transparent pixels. |
| `ignoreMask` | — | One byte per pixel; non-zero pixels are skipped. |
| `windowSize` | `Infinity` | Upstream windowed count; also returned as `coreCount`. |
| `regions` | `true` | `false` to skip region extraction, or `{mergeGap, minPixels}`. |
| `align` | `'none'` | `'auto'` estimates a global shift and compensates for it before comparing. |
| `detectShift` | `false` | Report the estimated shift without compensating. |
| `maxShift` | `4` | Shift search radius in pixels. |
| `minShiftGain` | `0.15` | Relative cost improvement required before `align: 'auto'` applies a shift. |
| `diff` | `false` | Return the diff RGBA buffer. |
| `annotate` | `false` | Return a diff with numbered region boxes (implies `diff`). |
| `alpha`, `aaColor`, `diffColor`, `diffColorAlt`, `diffMask` | upstream defaults | Passed through. |

Result fields:

| Field | Meaning |
| --- | --- |
| `diffPixels`, `totalPixels`, `diffRatio` | `diffRatio` is `diffPixels / (totalPixels - ignoredPixels)`. |
| `ignoredPixels`, `aaPixels` | Excluded by mask / detected as anti-aliasing. |
| `psnr` | `10 * log10(255² / MSE)` over non-ignored pixels, or `null` when identical. |
| `coreCount` | Exactly what `pixelmatch()` returned (windowed when `windowSize` is finite). |
| `regions` | Ranked array, see below. |
| `components` | Raw 8-connected components before gap merging. |
| `shift` | `{detected, dx, dy, gain, confidence, applied, maxShift}`. |
| `diff`, `annotated` | `Uint8Array` RGBA buffers or `null`. |

Each region:

| Field | Meaning |
| --- | --- |
| `id` | 1-based rank, ordered by `weight` descending. |
| `x`, `y`, `width`, `height` | Bounding box in pixels. |
| `pixels` | Differing pixels inside the box. |
| `density` | `pixels / (width * height)`; how solid the change is. |
| `coverage` | `pixels / (imageWidth * imageHeight)`; share of the whole image. |
| `diffuse` | `density < 0.35` — a sparse network rather than one block. |
| `meanDelta`, `maxDelta` | OKLab HyAB distance of its pixels. |
| `weight` | `pixels * meanDelta`, the ranking key. |
| `kind` | `added` (image 2 lighter), `removed` (darker), `mixed`. |
| `meanColorA`, `meanColorB` | Mean `[r, g, b]` in each image. |

### Lower-level helpers

Also exported from `pixelmatch-triage/triage` (and typed in `triage.d.ts`):
`estimateShift`, `shiftPixels`, `shiftMask`, `extractRegions`, `labelComponents`,
`annotateDiff`, `DEFAULT_PALETTE`.

### `pixelmatch()` additions

`index.js` gains two optional outputs; the default path is untouched.

| Option | Meaning |
| --- | --- |
| `detailMask` | `Uint8Array(width * height)`: `0` equal, `1` differing, `2` anti-aliased, `3` masked out. |
| `detailDeltas` | `Float32Array(width * height)`: full HyAB distance of differing pixels, `0` elsewhere. |

`detailDeltas` is deliberately expensive: upstream compares without ever taking the square root,
so the magnitude is computed in a post-pass over the differing pixels only.

## CLI

```bash
pixelmatch-triage before.png after.png --out-dir artifacts --name checkout
```

Reports are printed to stdout, and `--out-dir` writes `<name>-diff.png`,
`<name>-annotated.png` and `<name>-report.json`.

| Flag | Meaning |
| --- | --- |
| `--diff <f>`, `--annotated <f>`, `--json <f>` | Individual output paths; `--json -` prints JSON only. |
| `--out-dir <d>`, `--name <n>` | Shorthand for all three outputs. |
| `--threshold`, `--include-aa` | Upstream comparison options. |
| `--merge-gap`, `--min-pixels` | Region merging and filtering. |
| `--align`, `--max-shift` | Shift compensation. |
| `--psnr-min <n>` | Exit 66 when PSNR is below `n` dB. |
| `--quiet` | Suppress the human summary. |

Exit codes match upstream `bin/pixelmatch`: `0` match, `66` differ, `65` dimension mismatch,
`64` bad usage. The original `pixelmatch` binary is still shipped unchanged.

```bash
# fail a build on a strong regression but tolerate a tiny one
pixelmatch-triage a.png b.png --threshold 0.05 --psnr-min 35 --quiet
```

## Tests

```bash
npm test            # eslint + tsc --noEmit + node --test  (53 tests)
npm run test:core   # only the unmodified upstream suite (26 tests)
npm run test:browser # load both entry points in a real browser engine
npm run bench       # measured cost of each feature (see below)
npm run example     # the motivating scenario (see Why this exists)
```

`test/test.js` is upstream's suite, byte-for-byte unmodified: it is the regression gate for the
core. `test/triage.js` adds 27 tests for regions, merging, minPixels, masks, PSNR, shift
estimation, alignment (including mask realignment), annotation geometry, option validation,
windowed mode and the CLI including its exit codes.

`npm run test:browser` serves the repository over HTTP on a random port, launches a headless
Chrome/Edge (found automatically, or pass a path / set `CHROME_PATH`) and drives it over the
DevTools Protocol. It asserts the observable results of both entry points inside the browser:
`core === 49` for a 7×7 black square on white, one region with box `(5,5,7,7)`, a finite PSNR and
an annotated buffer of `width * height * 4`. Verified locally on Chrome 156; it is skipped from
`npm test` because it needs a browser binary, and runs as a separate CI step.

## Measured performance

`npm run bench`, 7 upstream fixture pairs (889,208 pixels per round), median of 40 interleaved
rounds after 4 warmups on a desktop Windows machine. Ratios are quoted to two significant figures
because that is what three consecutive runs supported (absolute times moved by under 3% between
them):

| Configuration | Median | vs upstream |
| --- | --- | --- |
| upstream `pixelmatch()` | ~11.4 ms | — |
| `compare()` with `regions: false` | ~12.7 ms | ~1.1× |
| `compare()` with regions | ~23.4 ms | ~2.0× |
| + diff buffer | ~28.3 ms | ~2.5× |
| + annotation | ~29.5 ms | ~2.6× |
| + `align: 'auto'` (9×9 offsets × 7 pairs) | ~78.9 ms | ~6.9× |

The fixture set is mixed by design (default threshold, differing pixel counts): `1a/1b` 121,
`2a/2b` 10424, `3a/3b` 200, `4a/4b` 7616, `5a/5b` 0 (identical), `6a/6b` 38, `7a/7b` 2440. The
wrapper overhead stays roughly constant across that range, so the added cost is dominated by fixed
per-pixel work (class map, MSE accumulation) rather than by the number of regions. The
single-number API is unaffected: `pixelmatch()` itself is unchanged. `align` is the expensive
option by construction: it compares every candidate offset, so its cost grows with
`(2 * maxShift + 1)²` (81 offsets per pair at the default `maxShift: 4`).

These numbers are specific to this machine and these fixtures; treat them as a shape, not a
promise. Re-run `npm run bench` on your own hardware before budgeting.

## Known limitations

1. **Shift is global and integer-only.** `estimateShift` models one whole-image translation with a
   search radius of `maxShift` pixels. It does not handle scaling, rotation, per-element movement
   (an animated carousel, an expanded menu), or subpixel offsets. Regional shifts are not
   estimated.
2. **Compensation uses edge clamping.** `shiftPixels` repeats the border pixel rather than
   revealing transparency, so a compensated comparison keeps a one-pixel-wide border artifact.
   Tests assert the remaining diff stays far below the unaligned one, not that it is zero.
3. **Merging is bounding-box based.** Two thin diagonal strokes can merge through a `mergeGap`
   larger than the gap between their boxes even when the strokes themselves are far apart. Raise
   `mergeGap` with care on sparse layouts; `components` reports the unmerged count so the effect
   is visible.
4. **`density` is a box measure.** A ring or a text line has a low density despite being a solid
   object. `diffuse` is a heuristic, not a classifier; use `pixels`, `density`, `meanDelta` and
   `kind` together.
5. **Anti-aliased pixels are not in the region map.** They are counted (`aaPixels`) but excluded
   from regions, matching upstream's decision to not treat them as differences.
6. **`psnr` is a plain RGB MSE**, not a perceptual metric. It exists for a pass/fail threshold
   comparable to `compare -metric PSNR`, not for image quality research.
7. **Browser support is verified for parsing and correctness, not for every engine.** The check in
   `scripts/browser-check.mjs` runs Chrome; Firefox and Safari were not tested here.
8. **`align: 'auto'` can misfire** when the two images differ mostly by content that legitimately
   moved in different directions; the global model then picks the dominant direction.
   `minShiftGain` guards the degenerate case where the estimate is noise.

## Provenance and license

- Upstream: **pixelmatch** by Volodymyr Agafonkin, © 2025 Mapbox, **ISC License**
  ([LICENSE](LICENSE), kept unmodified).
- This fork is distributed under the same **ISC License**. The ISC terms permit modification and
  redistribution provided the original copyright and permission notice are retained, which they
  are: `LICENSE` is unchanged and [NOTICE](NOTICE) records the origin, the base commit
  (`ab76f52`, v8.0.0), exactly which files are upstream's, and which are new.
- The git history contains the upstream commits; this fork's changes are the commits on top of
  `ab76f52`. `git log --oneline ab76f52..HEAD` lists them.
- No code was copied from other image-diff tools. The clustering, shift estimation and annotation
  code was written for this fork; the algorithms are described in the source comments
  (8-connected labelling, uniform-grid candidate search, strided sampling).
