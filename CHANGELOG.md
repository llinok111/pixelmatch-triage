# Changelog

Notable changes per release. This project is a derivative of
[pixelmatch](https://github.com/mapbox/pixelmatch); upstream release tags are preserved in the
history but do not describe this project's code.

## 0.2.0

### Added

- **Linked blocks.** `compare()` now pairs regions that hold the same content at two positions:
  `moves: [{a, b, dx, dy, distance, similarity}]`, with `summary.moved` / `summary.modified` and
  `region.moved` / `region.counterpart`. A relocated control stops reading as one deletion plus one
  addition.
- **Move connectors in annotations.** Linked boxes are joined by a dashed double-headed connector.
- **SARIF 2.1.0 output.** `toSarif(report, {uri, sourceLines, level, maxResults})` and
  `--sarif` / `--sarif-lines` / `--sarif-level` on the CLI, for GitHub code scanning.

### Fixed

- A pure-luma content signature scored 0.947 between a solid blue block and a solid red block of
  the same size, producing a false link. The signature now carries RGB.
- The default move radius was a fixed 96 px, which silently failed to link a 140 px relocation on a
  480×320 page. It now scales to half the larger image dimension (minimum 96 px), and the effective
  value is reported back as `options.maxMove`.
- Move options were validated only when at least two regions existed, so an invalid `maxMove` on an
  identical pair of images passed silently. Validation now happens before any per-pixel work.

### Changed

- CLI region lines now come from the shared `describe()` helper, so the console output and the SARIF
  message cannot drift apart.
- The JSON report gains `moves` and `regionKinds` (the latter is the per-kind region tally; the
  existing `summary` remains the pixel summary).

### Notes

- A link deliberately carries no direction: a block leaving A and appearing at B produces the same
  two images as the reverse, so the report gives the separation and says nothing about order.
- A copy and a move are indistinguishable at the pixel level; no link is claimed rather than a
  wrong one.

## 0.1.0

### Added

- `compare()` returning regions, shift report, PSNR, diff and annotated buffers.
- Connected-region triage with bounding-box gap merging through a uniform grid.
- Whole-image shift estimation and edge-clamped compensation, including the ignore mask.
- Annotated diff with numbered boxes and a 3×5 bitmap label font (no new dependencies).
- CLI with upstream-compatible exit codes (0/64/65/66), JSON report and `--psnr-min`.
- Optional `detailMask` / `detailDeltas` outputs on `pixelmatch()`; the default path is unchanged.
