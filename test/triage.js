import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

import {PNG} from 'pngjs';
import pixelmatch from '../index.js';
import {compare, estimateShift, shiftPixels, annotateDiff, detectMoves, toSarif, DEFAULT_PALETTE} from '../triage.js';

const fixture = name => PNG.sync.read(fs.readFileSync(new URL(`./fixtures/${name}.png`, import.meta.url)));

/** Build a WxH RGBA image filled with a solid colour. */
const solid = (width, height, [r, g, b, a = 255]) => {
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        data[i * 4] = r;
        data[i * 4 + 1] = g;
        data[i * 4 + 2] = b;
        data[i * 4 + 3] = a;
    }
    return data;
};

/** Fill a rectangle in an RGBA image. */
const fillRect = (data, width, x, y, w, h, [r, g, b, a = 255]) => {
    for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
            const p = (yy * width + xx) * 4;
            data[p] = r;
            data[p + 1] = g;
            data[p + 2] = b;
            data[p + 3] = a;
        }
    }
};

test('core count is unchanged when detail outputs are requested', () => {
    for (const name of ['1', '2', '4', '7']) {
        const a = fixture(`${name}a`);
        const b = fixture(`${name}b`);
        const baseline = pixelmatch(a.data, b.data, null, a.width, a.height, {threshold: 0.05});
        const result = compare(a.data, b.data, a.width, a.height, {threshold: 0.05});
        assert.equal(result.diffPixels, baseline, `fixture ${name} diverged from core count`);
        assert.equal(result.coreCount, baseline);
    }
});

test('default compare path allocates no diff buffers', () => {
    const a = fixture('1a');
    const b = fixture('1b');
    const result = compare(a.data, b.data, a.width, a.height, {threshold: 0.05});
    assert.equal(result.diff, null);
    assert.equal(result.annotated, null);
});

test('identical images report zero diff and null PSNR', () => {
    const a = fixture('1a');
    const result = compare(a.data, a.data, a.width, a.height);
    assert.equal(result.diffPixels, 0);
    assert.equal(result.diffRatio, 0);
    assert.equal(result.psnr, null);
    assert.deepEqual(result.regions, []);
});

test('detail buffers handed in by a caller are reset on the identical fast path', () => {
    const a = fixture('1a');
    const b = fixture('1b');
    const len = a.width * a.height;

    // a caller that reuses one pair of buffers across comparisons
    const mask = new Uint8Array(len).fill(1);
    const deltas = new Float32Array(len).fill(1);

    const differ = pixelmatch(a.data, b.data, null, a.width, a.height, {threshold: 0.05, detailMask: mask, detailDeltas: deltas});
    assert.ok(differ > 0);
    assert.ok(mask.some(v => v === 1), 'differing pixels must be marked in the mask');

    // an identical comparison must clear the previous classification instead of leaving it behind
    const same = pixelmatch(a.data, a.data, null, a.width, a.height, {threshold: 0.05, detailMask: mask, detailDeltas: deltas});
    assert.equal(same, 0);
    assert.equal(mask.reduce((sum, v) => sum + v, 0), 0, 'mask must be cleared on the identical fast path');
    assert.equal(deltas.reduce((sum, v) => sum + v, 0), 0, 'deltas must be cleared on the identical fast path');
});

test('separate blobs are reported as separate regions', () => {
    const width = 60;
    const height = 40;
    const img1 = solid(width, height, [255, 255, 255]);
    const img2 = solid(width, height, [255, 255, 255]);
    fillRect(img2, width, 5, 5, 4, 4, [0, 0, 0]);
    fillRect(img2, width, 40, 25, 4, 4, [0, 0, 0]);

    const result = compare(img1, img2, width, height, {threshold: 0.1, regions: {mergeGap: 1}});
    assert.equal(result.diffPixels, 32);
    assert.equal(result.regions.length, 2);

    const [first, second] = result.regions;
    assert.deepEqual([first.x, first.y, first.width, first.height], [5, 5, 4, 4]);
    assert.deepEqual([second.x, second.y, second.width, second.height], [40, 25, 4, 4]);
    assert.equal(first.kind, 'removed');
    assert.ok(first.meanDelta > 0.5, `near-black on white should be a strong delta, got ${first.meanDelta}`);
});

test('diagonally touching pixels form a single region', () => {
    const width = 10;
    const height = 10;
    const img1 = solid(width, height, [255, 255, 255]);
    const img2 = solid(width, height, [255, 255, 255]);
    img2[(2 * width + 2) * 4] = 0;
    img2[(2 * width + 2) * 4 + 1] = 0;
    img2[(2 * width + 2) * 4 + 2] = 0;
    img2[(3 * width + 3) * 4] = 0;
    img2[(3 * width + 3) * 4 + 1] = 0;
    img2[(3 * width + 3) * 4 + 2] = 0;

    const result = compare(img1, img2, width, height, {threshold: 0.1});
    assert.equal(result.diffPixels, 2);
    assert.equal(result.regions.length, 1);
    assert.deepEqual([result.regions[0].width, result.regions[0].height], [2, 2]);
});

test('mergeGap bridges nearby strokes but keeps distant changes apart', () => {
    const width = 40;
    const height = 20;
    const img1 = solid(width, height, [255, 255, 255]);
    const img2 = solid(width, height, [255, 255, 255]);
    fillRect(img2, width, 4, 4, 2, 2, [0, 0, 0]);
    fillRect(img2, width, 10, 4, 2, 2, [0, 0, 0]); // gap of 4 px
    fillRect(img2, width, 30, 4, 2, 2, [0, 0, 0]); // far away

    const tight = compare(img1, img2, width, height, {threshold: 0.1, regions: {mergeGap: 2}});
    const loose = compare(img1, img2, width, height, {threshold: 0.1, regions: {mergeGap: 4}});

    assert.equal(tight.regions.length, 3);
    assert.equal(loose.regions.length, 2);
    assert.equal(loose.components, 3, 'raw component count must not change with mergeGap');
});

test('minPixels filters small regions without changing the pixel count', () => {
    const width = 30;
    const height = 30;
    const img1 = solid(width, height, [255, 255, 255]);
    const img2 = solid(width, height, [255, 255, 255]);
    fillRect(img2, width, 2, 2, 6, 6, [0, 0, 0]);
    img2[(25 * width + 25) * 4] = 0; // single stray pixel

    const all = compare(img1, img2, width, height, {threshold: 0.1});
    const filtered = compare(img1, img2, width, height, {threshold: 0.1, regions: {minPixels: 5}});

    assert.equal(all.regions.length, 2);
    assert.equal(filtered.regions.length, 1);
    assert.equal(all.diffPixels, filtered.diffPixels, 'filtering regions must not drop pixels');
    assert.equal(filtered.diffPixels, 37);
});

test('ignoreMask pixels are excluded from regions and from PSNR', () => {
    const width = 20;
    const height = 20;
    const img1 = solid(width, height, [255, 255, 255]);
    const img2 = solid(width, height, [255, 255, 255]);
    fillRect(img2, width, 1, 1, 4, 4, [0, 0, 0]);
    fillRect(img2, width, 12, 12, 4, 4, [0, 0, 0]);

    const ignoreMask = new Uint8Array(width * height);
    for (let y = 12; y < 16; y++) for (let x = 12; x < 16; x++) ignoreMask[y * width + x] = 1;

    const result = compare(img1, img2, width, height, {threshold: 0.1, ignoreMask});
    assert.equal(result.diffPixels, 16);
    assert.equal(result.ignoredPixels, 16);
    assert.equal(result.regions.length, 1);
    // PSNR is normalised over the whole frame, so 16 pure-black pixels out of 400 give
    // 10*log10(255^2 / (16*255^2/400)) = 10*log10(25) = 13.98 dB (channel-averaged MSE lands at ~13.8)
    assert.ok(result.psnr > 13.5 && result.psnr < 14.1, `unexpected PSNR ${result.psnr}`);
    // the ignored block must not drag it down: doubling the differing pixels costs ~3 dB
    const unlimited = compare(img1, img2, width, height, {threshold: 0.1});
    assert.ok(unlimited.diffPixels === 32);
    assert.ok(unlimited.psnr < result.psnr - 2.5, `ignoring pixels should raise PSNR: ${unlimited.psnr} vs ${result.psnr}`);
});

test('diffRatio is computed over eligible pixels only', () => {
    const width = 10;
    const height = 10;
    const img1 = solid(width, height, [255, 255, 255]);
    const img2 = solid(width, height, [255, 255, 255]);
    fillRect(img2, width, 0, 0, 5, 1, [0, 0, 0]);

    const ignoreMask = new Uint8Array(width * height);
    for (let x = 5; x < 10; x++) ignoreMask[x] = 1; // ignore 5 of the 10 pixels in row 0

    const result = compare(img1, img2, width, height, {threshold: 0.1, ignoreMask});
    assert.equal(result.diffPixels, 5);
    assert.equal(result.ignoredPixels, 5);
    assert.equal(result.diffRatio, Math.round((5 / 95) * 1e6) / 1e6);
});

test('PSNR is infinite-free and drops as the difference grows', () => {
    const width = 8;
    const height = 8;
    const white = solid(width, height, [255, 255, 255]);
    const grey = solid(width, height, [128, 128, 128]);
    const black = solid(width, height, [0, 0, 0]);

    const mild = compare(white, grey, width, height);
    const severe = compare(white, black, width, height);
    assert.ok(mild.psnr > severe.psnr);
    assert.ok(Number.isFinite(severe.psnr));
});

test('region kind distinguishes added from removed content', () => {
    const width = 20;
    const height = 20;
    const base = solid(width, height, [200, 200, 200]);
    const lighter = solid(width, height, [200, 200, 200]);
    const darker = solid(width, height, [200, 200, 200]);
    fillRect(lighter, width, 2, 2, 5, 5, [255, 255, 255]);
    fillRect(darker, width, 2, 2, 5, 5, [60, 60, 60]);

    assert.equal(compare(base, lighter, width, height).regions[0].kind, 'added');
    assert.equal(compare(base, darker, width, height).regions[0].kind, 'removed');
});

test('regions rank by visual weight, so a large change outranks a faint one', () => {
    const width = 40;
    const height = 40;
    const img1 = solid(width, height, [255, 255, 255]);
    const img2 = solid(width, height, [255, 255, 255]);
    fillRect(img2, width, 2, 2, 2, 2, [0, 0, 0]); // small, strong
    fillRect(img2, width, 20, 20, 12, 12, [180, 180, 180]); // large, weak

    const result = compare(img1, img2, width, height, {threshold: 0.05});
    assert.equal(result.regions.length, 2);
    assert.equal(result.regions[0].pixels, 144, 'large weak region should rank first');
    assert.equal(result.regions[0].id, 1);
    assert.equal(result.regions[1].id, 2);
});

test('match at exact threshold boundary stays identical to core', () => {
    const width = 4;
    const height = 1;
    const img1 = new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
    const img2 = new Uint8Array([13, 13, 13, 255, 14, 14, 14, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
    for (const threshold of [0, 0.05, 0.1, 0.3, 1]) {
        const core = pixelmatch(img1, img2, null, width, height, {threshold});
        const result = compare(img1, img2, width, height, {threshold, regions: false});
        assert.equal(result.diffPixels, core, `threshold ${threshold}`);
    }
});

test('estimateShift finds a synthetic translation', () => {
    const width = 64;
    const height = 48;
    const img1 = solid(width, height, [240, 240, 240]);
    // asymmetric shapes so the shift is unambiguous
    fillRect(img1, width, 8, 6, 10, 14, [20, 20, 20]);
    fillRect(img1, width, 30, 20, 20, 6, [90, 90, 90]);
    fillRect(img1, width, 44, 30, 6, 6, [10, 40, 200]);

    const img2 = shiftPixels(img1, width, height, 2, -3);
    const estimate = estimateShift(img1, img2, width, height, {maxShift: 4});

    assert.equal(estimate.dx, 2);
    assert.equal(estimate.dy, -3);
    assert.ok(estimate.gain > 0.5, `gain should be high, got ${estimate.gain}`);
    assert.equal(estimate.confidence, estimate.gain);
});

test('estimateShift reports zero for identical images', () => {
    const img = solid(20, 20, [10, 120, 200]);
    const estimate = estimateShift(img, img, 20, 20);
    assert.equal(estimate.dx, 0);
    assert.equal(estimate.dy, 0);
    assert.equal(estimate.gain, 0);
});

test('align:auto recovers a shifted screenshot that would otherwise fail', () => {
    const width = 80;
    const height = 60;
    const img1 = solid(width, height, [250, 250, 250]);
    fillRect(img1, width, 10, 10, 24, 10, [30, 30, 30]);
    fillRect(img1, width, 10, 30, 40, 4, [30, 30, 30]);
    const img2 = shiftPixels(img1, width, height, 1, 1);

    const plain = compare(img1, img2, width, height, {threshold: 0.1});
    const aligned = compare(img1, img2, width, height, {threshold: 0.1, align: 'auto'});

    assert.ok(plain.diffPixels > 100, `unshifted comparison should flag the offset, got ${plain.diffPixels}`);
    assert.equal(aligned.shift.applied, true);
    assert.equal(aligned.shift.dx, 1);
    assert.equal(aligned.shift.dy, 1);
    // edge clamping leaves a one-pixel border artifact, everything else must match
    assert.ok(aligned.diffPixels < plain.diffPixels / 4, `alignment should cut the diff, got ${aligned.diffPixels}`);
});

test('align:auto does not shift when images already match', () => {
    const img = solid(30, 30, [12, 34, 56]);
    const result = compare(img, img, 30, 30, {align: 'auto'});
    assert.equal(result.diffPixels, 0);
    assert.equal(result.shift.applied, false);
});

test('align:auto keeps the mask aligned with the content', () => {
    const width = 40;
    const height = 40;
    const img1 = solid(width, height, [255, 255, 255]);
    fillRect(img1, width, 5, 5, 8, 8, [0, 0, 0]);
    const img2 = shiftPixels(img1, width, height, 1, 0);

    const ignoreMask = new Uint8Array(width * height);
    for (let y = 4; y < 15; y++) for (let x = 4; x < 15; x++) ignoreMask[y * width + x] = 1;

    const result = compare(img1, img2, width, height, {threshold: 0.1, align: 'auto', ignoreMask});
    assert.equal(result.shift.applied, true);
    assert.equal(result.diffPixels, 0, 'the ignored block must stay ignored after realignment');
});

test('annotateDiff paints a palette colour on every region edge', () => {
    const width = 30;
    const height = 20;
    const img1 = solid(width, height, [255, 255, 255]);
    const img2 = solid(width, height, [255, 255, 255]);
    fillRect(img2, width, 4, 4, 6, 5, [0, 0, 0]);
    fillRect(img2, width, 20, 12, 4, 3, [0, 0, 0]);

    const result = compare(img1, img2, width, height, {threshold: 0.1, annotate: true});
    assert.ok(result.annotated);
    const px = result.annotated;
    const at = (x, y) => {
        const p = (y * width + x) * 4;
        return [px[p], px[p + 1], px[p + 2]];
    };
    const eq = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

    for (const region of result.regions) {
        const color = DEFAULT_PALETTE[(region.id - 1) % DEFAULT_PALETTE.length];
        assert.ok(eq(at(region.x, region.y), color), `region ${region.id} top-left corner missing`);
        assert.ok(eq(at(region.x + region.width - 1, region.y), color), `region ${region.id} top edge missing`);
        assert.ok(eq(at(region.x, region.y + region.height - 1), color), `region ${region.id} left edge missing`);
    }
    assert.equal(result.annotated.length, width * height * 4);
});

test('annotateDiff leaves the source buffer untouched', () => {
    const width = 10;
    const height = 10;
    const src = new Uint8Array(width * height * 4).fill(128);
    const copy = Uint8Array.from(src);
    annotateDiff(src, width, height, [{id: 1, x: 1, y: 1, width: 4, height: 4}]);
    assert.deepEqual(Array.from(src), Array.from(copy));
});

test('invalid detail buffer sizes are rejected with a clear message', () => {
    const img = solid(4, 4, [0, 0, 0]);
    assert.throws(
        () => pixelmatch(img, img, null, 4, 4, {detailMask: new Uint8Array(3)}),
        /Detail mask must be a Uint8Array of 16 entries/
    );
    assert.throws(
        () => pixelmatch(img, img, null, 4, 4, {detailDeltas: new Float32Array(3)}),
        /Detail deltas must be a Float32Array of 16 entries/
    );
    assert.throws(
        () => pixelmatch(img, img, null, 4, 4, {detailDeltas: new Uint8Array(16)}),
        /Detail deltas must be a Float32Array of 16 entries/
    );
});

test('compare validates its own options', () => {
    const img = solid(4, 4, [0, 0, 0]);
    assert.throws(() => compare(img, img, 0, 4), /width and height must be positive integers/);
    assert.throws(() => compare(img, img, 4, 4, {align: 'maybe'}), /align must be 'none' or 'auto'/);
    assert.throws(() => compare(img, img, 4, 4, {regions: {mergeGap: -1}}), /mergeGap must be a non-negative integer/);
    assert.throws(() => compare(img, img, 4, 4, {regions: {minPixels: 0}}), /minPixels must be a positive integer/);
    assert.throws(() => estimateShift(img, img, 4, 4, {maxShift: -2}), /maxShift must be a non-negative integer/);
});

test('windowed mode still returns the core windowed count', () => {
    const width = 20;
    const height = 20;
    const img1 = solid(width, height, [255, 255, 255]);
    const img2 = solid(width, height, [255, 255, 255]);
    fillRect(img2, width, 5, 5, 4, 4, [0, 0, 0]);
    fillRect(img2, width, 14, 14, 1, 1, [0, 0, 0]);

    const core = pixelmatch(img1, img2, null, width, height, {windowSize: 6});
    const result = compare(img1, img2, width, height, {windowSize: 6});
    assert.equal(result.coreCount, core);
    assert.equal(result.diffPixels, 17);
    assert.equal(result.regions.length, 2);
});

test('CLI writes diff, annotated and JSON, and uses upstream exit codes', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-triage-cli-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const bin = fileURLToPath(new URL('../bin/pixelmatch-triage.js', import.meta.url));
    const a = fileURLToPath(new URL('./fixtures/1a.png', import.meta.url));
    const b = fileURLToPath(new URL('./fixtures/1b.png', import.meta.url));

    let code = 0;
    try {
        execFileSync(process.execPath, [bin, a, b, '--out-dir', dir, '--name', 'run', '--threshold', '0.05', '--quiet']);
    } catch (error) {
        code = /** @type {{status: number}} */ (error).status;
    }
    assert.equal(code, 66, 'differing images must exit 66');

    const report = JSON.parse(fs.readFileSync(`${dir}/run-report.json`, 'utf8'));
    assert.equal(report.summary.diffPixels, 152);
    assert.ok(report.regions.length > 0);
    assert.ok(fs.statSync(`${dir}/run-diff.png`).size > 0);
    assert.ok(fs.statSync(`${dir}/run-annotated.png`).size > 0);

    // identical images exit 0
    const same = execFileSync(process.execPath, [bin, a, a, '--quiet']);
    assert.equal(same.length, 0);

    // mismatched dimensions exit 65 (fixture 2a is 256x256 against 1a's 512x256)
    let dimCode = 0;
    try {
        execFileSync(process.execPath, [bin, a, fileURLToPath(new URL('./fixtures/2a.png', import.meta.url)), '--quiet']);
    } catch (error) {
        dimCode = /** @type {{status: number}} */ (error).status;
    }
    assert.equal(dimCode, 65);

    // a JSON report on stdout stays machine-readable; differing images still exit 66
    let stdoutJson = '';
    try {
        stdoutJson = execFileSync(process.execPath, [bin, a, b, '--json', '-', '--threshold', '0.05'], {encoding: 'utf8'});
    } catch (error) {
        assert.equal(/** @type {{status: number}} */ (error).status, 66);
        stdoutJson = /** @type {{stdout: string}} */ (error).stdout;
    }
    const parsed = JSON.parse(stdoutJson);
    assert.equal(parsed.summary.diffPixels, 152);
    assert.equal(parsed.source.width, 512);

    // --psnr-min turns a visually tiny change into a failure
    let psnrCode = 0;
    try {
        execFileSync(process.execPath, [bin, a, b, '--threshold', '0.05', '--psnr-min', '60', '--quiet']);
    } catch (error) {
        psnrCode = /** @type {{status: number}} */ (error).status;
    }
    assert.equal(psnrCode, 66);
});

test('CLI rejects an unknown flag with exit 64', () => {
    const bin = fileURLToPath(new URL('../bin/pixelmatch-triage.js', import.meta.url));
    let code = 0;
    try {
        execFileSync(process.execPath, [bin, 'a.png', 'b.png', '--nope'], {stdio: 'pipe'});
    } catch (error) {
        code = /** @type {{status: number}} */ (error).status;
    }
    assert.equal(code, 64);
});

// ---------------------------------------------------------------------------------------------
// v0.2.0: links between regions that hold the same content at two positions
// ---------------------------------------------------------------------------------------------

/** @return {Uint8Array} a white RGBA canvas */
const white = (width, height) => {
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        data[i * 4] = 255;
        data[i * 4 + 1] = 255;
        data[i * 4 + 2] = 255;
        data[i * 4 + 3] = 255;
    }
    return data;
};

test('a block of the same content at a new position is linked', () => {
    const width = 200;
    const height = 140;
    const before = white(width, height);
    const after = white(width, height);
    fillRect(before, width, 10, 10, 40, 20, [0, 102, 204]);
    fillRect(after, width, 70, 10, 40, 20, [0, 102, 204]);

    const result = compare(before, after, width, height, {threshold: 0.05});
    assert.equal(result.regions.length, 2);
    assert.equal(result.moves.length, 1);

    const move = result.moves[0];
    assert.equal(move.dx, 60);
    assert.equal(move.dy, 0);
    assert.equal(move.distance, 60);
    assert.equal(move.similarity, 1);

    const first = result.regions.find(r => r.id === move.a);
    const second = result.regions.find(r => r.id === move.b);
    assert.equal(first.moved, 'linked');
    assert.equal(first.counterpart, move.b);
    assert.equal(second.counterpart, move.a);

    assert.deepEqual(result.summary, {added: 1, removed: 1, mixed: 0, moved: 1, modified: 0});
});

test('two same-sized blocks of different colour are not linked', () => {
    const width = 200;
    const height = 140;
    const before = white(width, height);
    const after = white(width, height);
    fillRect(before, width, 10, 10, 40, 20, [0, 102, 204]);
    fillRect(after, width, 70, 10, 40, 20, [204, 51, 51]);

    const result = compare(before, after, width, height, {threshold: 0.05});
    assert.equal(result.regions.length, 2);
    assert.deepEqual(result.moves, [], 'different content must not be linked');
    assert.equal(result.summary.moved, 0);
    assert.equal(result.summary.modified, 2);
});

test('a link is not claimed beyond maxMove', () => {
    const width = 240;
    const height = 140;
    const before = white(width, height);
    const after = white(width, height);
    fillRect(before, width, 5, 10, 30, 20, [0, 102, 204]);
    fillRect(after, width, 205, 10, 30, 20, [0, 102, 204]);

    const close = compare(before, after, width, height, {threshold: 0.05, maxMove: 200});
    const far = compare(before, after, width, height, {threshold: 0.05, maxMove: 96});

    assert.equal(close.moves.length, 1);
    assert.equal(close.moves[0].distance, 200);
    assert.equal(far.moves.length, 0);
});

test('a duplicated control is not reported as a move', () => {
    const width = 240;
    const height = 140;
    const before = white(width, height);
    const after = white(width, height);
    fillRect(before, width, 10, 10, 30, 20, [0, 102, 204]);
    fillRect(after, width, 10, 10, 30, 20, [0, 102, 204]);
    fillRect(after, width, 100, 10, 30, 20, [0, 102, 204]);

    const result = compare(before, after, width, height, {threshold: 0.05});
    assert.equal(result.regions.length, 1);
    assert.deepEqual(result.moves, []);
});

test('moves can be disabled without changing the diff', () => {
    const width = 200;
    const height = 140;
    const before = white(width, height);
    const after = white(width, height);
    fillRect(before, width, 10, 10, 40, 20, [0, 102, 204]);
    fillRect(after, width, 70, 10, 40, 20, [0, 102, 204]);

    const withLinks = compare(before, after, width, height, {threshold: 0.05});
    const without = compare(before, after, width, height, {threshold: 0.05, moves: false});

    assert.equal(without.moves.length, 0);
    assert.equal(without.diffPixels, withLinks.diffPixels);
    assert.deepEqual(without.regions.map(r => [r.id, r.pixels]), withLinks.regions.map(r => [r.id, r.pixels]));
    assert.equal(without.summary.moved, 0);
    assert.equal(without.summary.modified, 2);
});

test('links are drawn as arrows on the annotated output', () => {
    const width = 200;
    const height = 140;
    const before = white(width, height);
    const after = white(width, height);
    fillRect(before, width, 10, 10, 40, 20, [0, 102, 204]);
    fillRect(after, width, 70, 10, 40, 20, [0, 102, 204]);

    const linked = compare(before, after, width, height, {threshold: 0.05, annotate: true});
    assert.equal(linked.moves.length, 1);

    // the arrow adds pixels that are not part of either box or its label chip
    const painted = (buf) => {
        let n = 0;
        for (let i = 0; i < buf.length; i += 4) {
            if (buf[i] !== 255 || buf[i + 1] !== 255 || buf[i + 2] !== 255) n++;
        }
        return n;
    };
    const withoutArrows = annotateDiff(linked.diff, width, height, linked.regions);
    assert.ok(painted(linked.annotated) > painted(withoutArrows), 'the arrow must add visible pixels');
});

test('move options are validated', () => {
    const img = white(10, 10);
    assert.throws(() => compare(img, img, 10, 10, {maxMove: -1}), /maxMove must be a non-negative number/);
    assert.throws(() => compare(img, img, 10, 10, {minMoveSimilarity: 2}), /minMoveSimilarity must be between 0 and 1/);
    assert.throws(() => compare(img, img, 10, 10, {minMovePixels: 0}), /minMovePixels must be a positive integer/);
});

test('detectMoves returns an empty result for fewer than two eligible regions', () => {
    const img = white(20, 20);
    const result = detectMoves({regions: [], img1: img, img2: img, width: 20, height: 20});
    assert.deepEqual(result.moves, []);
    assert.equal(result.pairs.size, 0);
});

// ---------------------------------------------------------------------------------------------
// v0.2.0: SARIF output for code scanning
// ---------------------------------------------------------------------------------------------

test('SARIF output carries one result per region with its geometry', () => {
    const width = 120;
    const height = 80;
    const before = white(width, height);
    const after = white(width, height);
    fillRect(after, width, 10, 10, 8, 6, [0, 0, 0]);
    fillRect(after, width, 60, 40, 6, 4, [0, 0, 0]);

    const report = compare(before, after, width, height, {threshold: 0.05});
    const sarif = toSarif(report, {uri: 'screens/after.png', sourceLines: 800});

    assert.equal(sarif.version, '2.1.0');
    assert.equal(sarif.runs.length, 1);

    const run = sarif.runs[0];
    assert.equal(run.tool.driver.name, 'pixelmatch-triage');
    assert.equal(run.tool.driver.rules[0].id, 'visual-regression');
    assert.equal(run.results.length, report.regions.length);

    const first = run.results[0];
    assert.equal(first.ruleId, 'visual-regression');
    assert.equal(first.level, 'warning');
    assert.equal(first.locations[0].physicalLocation.artifactLocation.uri, 'screens/after.png');

    const line = first.locations[0].physicalLocation.region;
    // region 1 sits near the top of an 80px tall image mapped onto 800 lines
    assert.ok(line.startLine >= 1 && line.startLine <= 800, `line out of range: ${line.startLine}`);
    assert.equal(line.startColumn, report.regions[0].x + 1);
    assert.equal(first.properties.regionId, report.regions[0].id);
    assert.equal(first.properties.pixels, report.regions[0].pixels);
});

test('SARIF omits line info when no line count is given', () => {
    const before = white(40, 40);
    const after = white(40, 40);
    fillRect(after, 40, 5, 5, 4, 4, [0, 0, 0]);
    const report = compare(before, after, 40, 40, {threshold: 0.05});
    const sarif = toSarif(report);
    assert.equal(sarif.runs[0].results[0].locations[0].physicalLocation.region, undefined);
});

test('SARIF caps results but keeps the strongest regions', () => {
    const width = 120;
    const height = 60;
    const before = white(width, height);
    const after = white(width, height);
    for (let i = 0; i < 5; i++) fillRect(after, width, 5 + i * 20, 10, 6, 6, [0, 0, 0]);

    const report = compare(before, after, width, height, {threshold: 0.05});
    assert.equal(report.regions.length, 5);
    const sarif = toSarif(report, {maxResults: 2});
    assert.equal(sarif.runs[0].results.length, 2);
    // regions are ranked by weight, so the cap must keep ids 1 and 2
    assert.deepEqual(sarif.runs[0].results.map(r => r.properties.regionId), [1, 2]);
});

test('SARIF reports the linked counterpart of a moved block', () => {
    const width = 200;
    const height = 140;
    const before = white(width, height);
    const after = white(width, height);
    fillRect(before, width, 10, 10, 40, 20, [0, 102, 204]);
    fillRect(after, width, 70, 10, 40, 20, [0, 102, 204]);

    const report = compare(before, after, width, height, {threshold: 0.05});
    assert.equal(report.moves.length, 1);
    const sarif = toSarif(report);
    const linked = sarif.runs[0].results.map(r => r.properties.linkedTo);
    assert.ok(linked.every(id => typeof id === 'number'), 'both ends must name their counterpart');
    assert.match(sarif.runs[0].results[0].message.text, /same content as region \d+/);
});

test('SARIF is valid JSON and survives a round trip', () => {
    const before = white(30, 30);
    const after = white(30, 30);
    fillRect(after, 30, 4, 4, 5, 5, [0, 0, 0]);
    const report = compare(before, after, 30, 30, {threshold: 0.05, annotate: true});

    const text = JSON.stringify(toSarif(report, {sourceLines: 100}));
    const parsed = JSON.parse(text);
    assert.equal(parsed.runs[0].results.length, report.regions.length);
    // the SARIF log must not drag the pixel buffers along
    assert.ok(text.length < 20000, `unexpectedly large SARIF: ${text.length} bytes`);
});

test('SARIF validates its options', () => {
    const report = compare(white(10, 10), white(10, 10), 10, 10);
    assert.throws(() => toSarif(report, {maxResults: 0}), /maxResults must be a positive integer/);
    assert.throws(() => toSarif(report, {level: 'fatal'}), /level must be one of/);
});

test('CLI writes a SARIF file that parses', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-triage-sarif-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const bin = fileURLToPath(new URL('../bin/pixelmatch-triage.js', import.meta.url));
    const a = fileURLToPath(new URL('./fixtures/1a.png', import.meta.url));
    const b = fileURLToPath(new URL('./fixtures/1b.png', import.meta.url));

    let code = 0;
    try {
        execFileSync(process.execPath, [bin, a, b, '--threshold', '0.05', '--sarif', `${dir}/out.sarif`, '--sarif-lines', '256', '--quiet']);
    } catch (error) {
        code = /** @type {{status: number}} */ (error).status;
    }
    assert.equal(code, 66);

    const sarif = JSON.parse(fs.readFileSync(`${dir}/out.sarif`, 'utf8'));
    assert.equal(sarif.version, '2.1.0');
    assert.ok(sarif.runs[0].results.length > 0);
    assert.equal(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, '1b.png');
});

test('SARIF tool version matches package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const report = compare(white(10, 10), white(10, 10), 10, 10);
    const sarif = toSarif(report);
    assert.equal(sarif.runs[0].tool.driver.version, pkg.version, 'lib/sarif.js TOOL_VERSION drifted from package.json');
});

test('the default move radius scales with the image, so a cross-page move is still linked', () => {
    // regression: a fixed 96 px default silently dropped a 140 px relocation on a 480x320 page
    const width = 480;
    const height = 320;
    const before = white(width, height);
    const after = white(width, height);
    fillRect(before, width, 24, 260, 90, 30, [0, 102, 204]);
    fillRect(after, width, 164, 260, 90, 30, [0, 102, 204]);

    const result = compare(before, after, width, height, {threshold: 0.05});
    assert.equal(result.moves.length, 1, 'a 140 px move on a 480 px wide page must be linked');
    assert.equal(result.moves[0].distance, 140);
    assert.equal(result.moves[0].similarity, 1);
    assert.equal(result.summary.moved, 1);
    assert.equal(result.summary.modified, 0);

    // and the effective radius is reported back, so a caller can see what was searched
    assert.equal(result.options.maxMove, 240);
});
