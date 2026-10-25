/**
 * Rich comparison API: same pixel decisions as pixelmatch, plus regions, shift estimate and
 * quantitative metrics.
 *
 * Design constraint: the default export of `index.js` keeps its exact upstream behaviour and
 * signature. Everything here is additive and opt-in, so existing callers cannot regress.
 */

import pixelmatch from './index.js';
import {extractRegions, labelComponents} from './lib/regions.js';
import {estimateShift, shiftPixels, shiftMask} from './lib/shift.js';
import {annotateDiff} from './lib/annotate.js';

export {extractRegions, labelComponents, estimateShift, shiftPixels, shiftMask, annotateDiff};
export {DEFAULT_PALETTE} from './lib/annotate.js';

/**
 * @typedef {object} ShiftReport
 * @property {boolean} detected Whether a non-zero offset was found.
 * @property {number} dx
 * @property {number} dy
 * @property {number} gain Improvement over zero offset (0–1).
 * @property {number} confidence Alias of `gain`.
 * @property {boolean} applied Whether the offset was compensated before comparison.
 * @property {number} maxShift Search radius used.
 */

/**
 * @typedef {object} CompareResult
 * @property {number} width
 * @property {number} height
 * @property {number} totalPixels
 * @property {number} diffPixels
 * @property {number} diffRatio `diffPixels / (totalPixels - ignoredPixels)`.
 * @property {number} ignoredPixels
 * @property {number} aaPixels
 * @property {number | null} psnr Peak signal-to-noise ratio over non-ignored pixels (null when identical).
 * @property {ShiftReport} shift
 * @property {import('./lib/regions.js').Region[]} regions
 * @property {Uint8Array | null} diff
 * @property {Uint8Array | null} annotated
 * @property {number} coreCount Whatever `pixelmatch()` returned, which is window-based when `windowSize` is finite.
 * @property {number} components Number of 8-connected components before gap merging.
 * @property {object} options Effective options.
 */

/**
 * Compare two images and return a full report.
 *
 * @param {Uint8Array | Uint8ClampedArray} img1
 * @param {Uint8Array | Uint8ClampedArray} img2
 * @param {number} width
 * @param {number} height
 * @param {object} [options]
 * @param {number} [options.threshold=0.1]
 * @param {boolean} [options.includeAA=false]
 * @param {boolean} [options.checkerboard=true]
 * @param {Uint8Array | Uint8ClampedArray} [options.ignoreMask]
 * @param {number} [options.windowSize=Infinity]
 * @param {boolean | {mergeGap?: number, minPixels?: number}} [options.regions=true]
 * @param {'none' | 'auto'} [options.align='none'] Compensate for a detected global shift before comparing.
 * @param {boolean} [options.detectShift=false] Report the estimated global shift without compensating for it.
 * @param {number} [options.maxShift=4] Search radius for shift estimation.
 * @param {number} [options.minShiftGain=0.15] Minimum relative cost improvement required to auto-align.
 * @param {boolean} [options.diff=false] Return the diff RGBA buffer.
 * @param {boolean} [options.annotate=false] Return an annotated diff with region boxes (implies `diff`).
 * @param {number} [options.alpha=0.1]
 * @param {[number, number, number]} [options.aaColor]
 * @param {[number, number, number]} [options.diffColor]
 * @param {[number, number, number]} [options.diffColorAlt]
 * @param {boolean} [options.diffMask=false]
 * @return {CompareResult}
 */
export function compare(img1, img2, width, height, options = {}) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        throw new Error(`width and height must be positive integers. Got ${width}x${height}.`);
    }

    const {
        threshold = 0.1,
        includeAA = false,
        checkerboard = true,
        ignoreMask,
        windowSize = Infinity,
        regions = true,
        align = 'none',
        detectShift = false,
        maxShift = 4,
        minShiftGain = 0.15,
        diff = false,
        annotate = false,
        alpha = 0.1,
        aaColor,
        diffColor,
        diffColorAlt,
        diffMask = false
    } = options;

    if (align !== 'none' && align !== 'auto') {
        throw new Error(`align must be 'none' or 'auto'. Got ${String(align)}.`);
    }

    const total = width * height;

    // shift estimation must happen before we allocate per-pixel detail buffers
    /** @type {ShiftReport} */
    let shift = {detected: false, dx: 0, dy: 0, gain: 0, confidence: 0, applied: false, maxShift};

    /** @type {Uint8Array | Uint8ClampedArray} */
    let compared = img2;
    /** @type {Uint8Array | Uint8ClampedArray | undefined} */
    let comparedMask = ignoreMask;

    if (align === 'auto' && maxShift > 0) {
        const estimate = estimateShift(img1, img2, width, height, {maxShift});
        shift = {
            detected: (estimate.dx !== 0 || estimate.dy !== 0) && estimate.gain > 0,
            dx: estimate.dx,
            dy: estimate.dy,
            gain: round(estimate.gain, 6),
            confidence: round(estimate.confidence, 6),
            applied: false,
            maxShift
        };

        if (estimate.gain >= minShiftGain && (estimate.dx !== 0 || estimate.dy !== 0)) {
            // content of img2 is offset by (dx, dy); move it back by the same amount
            compared = shiftPixels(img2, width, height, -estimate.dx, -estimate.dy);
            if (ignoreMask) comparedMask = shiftMask(ignoreMask, width, height, -estimate.dx, -estimate.dy);
            shift.applied = true;
        }
    } else if (maxShift > 0 && detectShift) {
        // report-only mode: measure but do not touch the compared pixels
        const estimate = estimateShift(img1, img2, width, height, {maxShift});
        shift = {
            detected: (estimate.dx !== 0 || estimate.dy !== 0) && estimate.gain > 0,
            dx: estimate.dx,
            dy: estimate.dy,
            gain: round(estimate.gain, 6),
            confidence: round(estimate.confidence, 6),
            applied: false,
            maxShift
        };
    }

    const regionOptions = typeof regions === 'object' && regions !== null ? regions : {};
    const mergeGap = regionOptions.mergeGap ?? 3;
    const minPixels = regionOptions.minPixels ?? 1;

    // validate before doing any per-pixel work so bad options fail fast
    if (!Number.isInteger(mergeGap) || mergeGap < 0) {
        throw new Error(`regions.mergeGap must be a non-negative integer. Got ${mergeGap}.`);
    }
    if (!Number.isInteger(minPixels) || minPixels < 1) {
        throw new Error(`regions.minPixels must be a positive integer. Got ${minPixels}.`);
    }

    // the classification buffer is only filled by the core when regions or distances are needed:
    // without them the core skips every detail write, which keeps this wrapper close to the cost
    // of a plain `pixelmatch()` call
    const wantClass = Boolean(regions);
    const classMap = wantClass ? new Uint8Array(total) : null;
    // per-pixel HyAB distances are only needed to rank regions by strength
    const deltas = wantClass ? new Float32Array(total) : null;

    const wantDiff = diff || annotate;
    const output = wantDiff ? new Uint8Array(total * 4) : null;

    const coreCount = pixelmatch(img1, compared, output, width, height, {
        threshold,
        includeAA,
        checkerboard,
        alpha,
        aaColor,
        diffColor,
        diffColorAlt,
        diffMask,
        windowSize,
        ignoreMask: comparedMask,
        detailMask: classMap ?? undefined,
        detailDeltas: deltas ?? undefined
    });

    let diffPixels = 0;
    let aaPixels = 0;
    let ignoredPixels = 0;
    let mseSum = 0;
    let mseCount = 0;

    // Three-way split rather than one loop with branches: each variant keeps the hot arithmetic
    // branch-free, which matters because this runs once per pixel of every compared image pair.
    if (classMap) {
        // classification known: one pass collects everything
        for (let i = 0, pos = 0; i < total; i++, pos += 4) {
            const cls = classMap[i];
            if (cls === 1) diffPixels++;
            else if (cls === 2) aaPixels++;
            else if (cls === 3) ignoredPixels++;
            if (cls === 3) continue; // excluded pixels must not influence PSNR

            const dr = compared[pos] - img1[pos];
            const dg = compared[pos + 1] - img1[pos + 1];
            const db = compared[pos + 2] - img1[pos + 2];
            mseSum += dr * dr + dg * dg + db * db;
            mseCount++;
        }
    } else if (comparedMask) {
        // caller-supplied mask only: count and accumulate in the same pass
        for (let i = 0, pos = 0; i < total; i++, pos += 4) {
            if (comparedMask[i] !== 0) {
                ignoredPixels++;
                continue;
            }
            const dr = compared[pos] - img1[pos];
            const dg = compared[pos + 1] - img1[pos + 1];
            const db = compared[pos + 2] - img1[pos + 2];
            mseSum += dr * dr + dg * dg + db * db;
            mseCount++;
        }
    } else {
        // no mask at all: every pixel is eligible
        for (let pos = 0; pos < total * 4; pos += 4) {
            const dr = compared[pos] - img1[pos];
            const dg = compared[pos + 1] - img1[pos + 1];
            const db = compared[pos + 2] - img1[pos + 2];
            mseSum += dr * dr + dg * dg + db * db;
        }
        mseCount = total;
    }

    if (!classMap) diffPixels = coreCount;

    const eligible = Math.max(1, total - ignoredPixels);
    // mseSum holds squared error summed over all three channels, so divide by (pixels * channels)
    const mse = mseCount ? mseSum / (mseCount * 3) : 0;
    const psnr = mse === 0 ? null : round(10 * Math.log10((255 * 255) / mse), 3);

    const extracted = regions && classMap ?
        extractRegions({
            classMap,
            deltas,
            img1,
            img2: compared,
            width,
            height,
            mergeGap,
            minPixels
        }) :
        {regions: [], components: 0, mergedRegions: 0};

    return {
        width,
        height,
        totalPixels: total,
        diffPixels,
        diffRatio: round(diffPixels / eligible, 6),
        ignoredPixels,
        aaPixels,
        psnr,
        shift,
        regions: extracted.regions,
        diff: wantDiff ? /** @type {Uint8Array} */ (output) : null,
        annotated: annotate && output ?
            annotateDiff(output, width, height, extracted.regions) :
            null,
        coreCount,
        components: extracted.components,
        options: {
            threshold,
            includeAA,
            checkerboard,
            mergeGap,
            minPixels,
            windowSize,
            align
        }
    };
}

/** @param {number} value @param {number} digits */
function round(value, digits) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}
