/**
 * Global translation estimation for screenshot comparison.
 *
 * Browsers place anti-aliased text on slightly different subpixel origins between runs, and a
 * one-pixel layout shift makes every glyph edge differ. pixelmatch then reports a large diff for
 * content that is semantically identical. This module estimates the dominant integer offset
 * between two images so the caller can either report it or compensate for it before comparing.
 *
 * The estimator is deliberately simple and cheap: mean absolute difference of Rec.601 luma over a
 * strided sample grid, scored for every candidate offset. It is a whole-image translation model —
 * it does not handle local shifts, scaling, or rotation, and it reports integer offsets only.
 */

/**
 * @param {Uint8Array | Uint8ClampedArray} img
 * @param {number} width
 * @param {number} height
 * @return {Uint8Array} Rec.601 luma, one byte per pixel.
 */
export function toLuma(img, width, height) {
    const len = width * height;
    const luma = new Uint8Array(len);
    for (let i = 0, pos = 0; i < len; i++, pos += 4) {
        luma[i] = (img[pos] * 0.29889531 + img[pos + 1] * 0.58662247 + img[pos + 2] * 0.11448223 + 0.5) | 0;
    }
    return luma;
}

/**
 * @typedef {object} ShiftEstimate
 * @property {number} dx Horizontal content offset of `img2` relative to `img1`, in pixels.
 * @property {number} dy Vertical content offset of `img2` relative to `img1`, in pixels.
 * @property {number} cost Normalised mean absolute luma difference at the best offset (0–1).
 * @property {number} baselineCost Same measure at zero offset.
 * @property {number} gain `1 - cost / baselineCost`, clamped to 0–1. 0 means no improvement.
 * @property {number} confidence Alias of `gain` kept explicit for API readability.
 * @property {number} overlap Fraction of sampled pixels that had a counterpart at the best offset.
 */

/**
 * Estimate the dominant integer translation between two equally sized images.
 *
 * Sampling is capped at roughly 16k points regardless of image size, so cost stays flat for 4K
 * screenshots. Offsets are scored with a small tie-break penalty toward zero so that flat images
 * (where many offsets score equally) do not report an arbitrary large shift.
 *
 * @param {Uint8Array | Uint8ClampedArray} img1
 * @param {Uint8Array | Uint8ClampedArray} img2
 * @param {number} width
 * @param {number} height
 * @param {object} [options]
 * @param {number} [options.maxShift=4] Maximum absolute offset tested on each axis.
 * @param {number} [options.minOverlap=0.5] Minimum share of samples that must fall inside both images.
 * @return {ShiftEstimate}
 */
export function estimateShift(img1, img2, width, height, {maxShift = 4, minOverlap = 0.5} = {}) {
    if (!Number.isInteger(maxShift) || maxShift < 0) {
        throw new Error(`maxShift must be a non-negative integer. Got ${maxShift}.`);
    }

    const luma1 = toLuma(img1, width, height);
    const luma2 = toLuma(img2, width, height);

    const total = width * height;
    const stride = Math.max(1, Math.floor(Math.sqrt(total / 16384)));

    /** @type {number[]} */
    const sampleX = [];
    /** @type {number[]} */
    const sampleY = [];
    for (let y = 0; y < height; y += stride) {
        for (let x = 0; x < width; x += stride) {
            sampleX.push(x);
            sampleY.push(y);
        }
    }
    const sampleCount = sampleX.length;

    /** @type {(dx: number, dy: number) => {cost: number, count: number}} */
    const scoreAt = (dx, dy) => {
        let sum = 0;
        let count = 0;
        for (let s = 0; s < sampleCount; s++) {
            const x = sampleX[s] + dx;
            const y = sampleY[s] + dy;
            if (x < 0 || y < 0 || x >= width || y >= height) continue;
            const a = sampleY[s] * width + sampleX[s];
            const b = y * width + x;
            sum += Math.abs(luma1[a] - luma2[b]);
            count++;
        }
        return {cost: count ? sum / (count * 255) : Infinity, count};
    };

    const baseline = scoreAt(0, 0);

    let best = {dx: 0, dy: 0, cost: baseline.cost, count: baseline.count};
    let bestAdjusted = baseline.cost;

    for (let dy = -maxShift; dy <= maxShift; dy++) {
        for (let dx = -maxShift; dx <= maxShift; dx++) {
            if (dx === 0 && dy === 0) continue;
            const {cost, count} = scoreAt(dx, dy);
            if (!Number.isFinite(cost)) continue;
            if (count < sampleCount * minOverlap) continue;

            // flat regions can tie across many offsets; prefer the smallest displacement
            const adjusted = cost * (1 + 0.001 * (Math.abs(dx) + Math.abs(dy)));
            if (adjusted < bestAdjusted) {
                bestAdjusted = adjusted;
                best = {dx, dy, cost, count};
            }
        }
    }

    const gain = baseline.cost > 0 ? Math.max(0, Math.min(1, 1 - best.cost / baseline.cost)) : 0;

    return {
        dx: best.dx,
        dy: best.dy,
        cost: best.cost,
        baselineCost: baseline.cost,
        gain,
        confidence: gain,
        overlap: sampleCount ? best.count / sampleCount : 0
    };
}

/**
 * Move image content by `(dx, dy)` using edge clamping.
 *
 * Clamping (rather than transparent or black fill) keeps the border pixels in the same colour
 * family as their neighbours, so a compensation shift does not fabricate a hard border edge that
 * would itself show up as a diff.
 *
 * @param {Uint8Array | Uint8ClampedArray} src
 * @param {number} width
 * @param {number} height
 * @param {number} dx
 * @param {number} dy
 * @return {Uint8Array}
 */
export function shiftPixels(src, width, height, dx, dy) {
    if (dx === 0 && dy === 0) return Uint8Array.from(src);

    const out = new Uint8Array(src.length);
    for (let y = 0; y < height; y++) {
        const sy = Math.min(height - 1, Math.max(0, y - dy));
        for (let x = 0; x < width; x++) {
            const sx = Math.min(width - 1, Math.max(0, x - dx));
            const from = (sy * width + sx) * 4;
            const to = (y * width + x) * 4;
            out[to] = src[from];
            out[to + 1] = src[from + 1];
            out[to + 2] = src[from + 2];
            out[to + 3] = src[from + 3];
        }
    }
    return out;
}

/**
 * Shift a one-byte-per-pixel mask (e.g. `ignoreMask`) with the same edge-clamping rule.
 *
 * @param {Uint8Array | Uint8ClampedArray} src
 * @param {number} width
 * @param {number} height
 * @param {number} dx
 * @param {number} dy
 * @return {Uint8Array}
 */
export function shiftMask(src, width, height, dx, dy) {
    if (dx === 0 && dy === 0) return Uint8Array.from(src);

    const out = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        const sy = Math.min(height - 1, Math.max(0, y - dy));
        for (let x = 0; x < width; x++) {
            const sx = Math.min(width - 1, Math.max(0, x - dx));
            out[y * width + x] = src[sy * width + sx];
        }
    }
    return out;
}
