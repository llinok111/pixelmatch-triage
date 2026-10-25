/**
 * Link regions that hold the same content at two different positions ("moved blocks").
 *
 * Why a link instead of a direction: a block that leaves A and appears at B produces exactly the
 * pixel content of a block that left B and appeared at A, because the vacated area and the
 * previously empty area are both background. Pixels alone therefore cannot say which position came
 * first, so this module reports the pair and the separation, and never claims a direction.
 *
 * What it does not do: it cannot distinguish a move from a duplicate (copying a control looks the
 * same), it does not model scaling or rotation, and it only links regions the diff already found
 * as substantial.
 */

/**
 * @typedef {object} Move
 * @property {number} a Id of the first region (always the smaller id).
 * @property {number} b Id of the second region.
 * @property {number} dx `b.x - a.x`, in pixels.
 * @property {number} dy `b.y - a.y`, in pixels.
 * @property {number} distance Euclidean separation of the box origins, in pixels.
 * @property {number} similarity 0–1; 1 means the sampled content matches exactly.
 */

/**
 * Colour signature of a rectangle, sampled on a grid so cost does not grow with region area.
 *
 * Three channels, not luma: a pure-luma signature cannot tell a solid blue block from a solid red
 * one, because both are flat and their Rec.601 luminance happens to be close. Storing the channels
 * keeps the comparison sensitive to hue, which is what distinguishes two unrelated widgets of the
 * same size from one widget that changed position.
 *
 * @param {Uint8Array | Uint8ClampedArray} img RGBA buffer.
 * @param {number} imgWidth
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {number} step Sample stride in pixels.
 * @return {Float32Array} Three values per sample, in R, G, B order.
 */
function signature(img, imgWidth, x, y, w, h, step) {
    const cols = Math.ceil(w / step);
    const rows = Math.ceil(h / step);
    const out = new Float32Array(cols * rows * 3);
    let k = 0;
    for (let sy = 0; sy < rows; sy++) {
        for (let sx = 0; sx < cols; sx++) {
            const px = x + sx * step;
            const py = y + sy * step;
            const pos = (py * imgWidth + px) * 4;
            out[k++] = img[pos];
            out[k++] = img[pos + 1];
            out[k++] = img[pos + 2];
        }
    }
    return out;
}

/**
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @return {number} 0–1 similarity.
 */
function similarityOf(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return 1 - (sum / a.length) / 255;
}

/**
 * Link regions that are the same content at two positions.
 *
 * Candidate pairs are restricted by size first (a translation keeps the bounding box size), then by
 * displacement, and only then is content sampled. That ordering keeps a screenshot with hundreds of
 * tiny regions from turning into a quadratic content comparison.
 *
 * The test is cross-image: the content of `img1` at one box must match `img2` at the other. Two
 * unrelated changes of the same size fail that test, because each box holds its own new content.
 *
 * @param {object} input
 * @param {Array<import('./regions.js').Region>} input.regions
 * @param {Uint8Array | Uint8ClampedArray} input.img1 Previous image (RGBA).
 * @param {Uint8Array | Uint8ClampedArray} input.img2 New image (RGBA).
 * @param {number} input.width
 * @param {number} input.height
 * @param {number} [input.maxMove=96] Maximum |dx| and |dy| considered, in pixels.
 * @param {number} [input.minSimilarity=0.85] Minimum content similarity for a link.
 * @param {number} [input.minPixels=20] Regions smaller than this are never linked (speckles, AA residue).
 * @param {number} [input.maxCandidates=50000] Safety cap on sampled candidate pairs.
 * @return {{moves: Move[], pairs: Map<number, number>}}
 */
export function detectMoves({
    regions, img1, img2, width,
    maxMove = 96, minSimilarity = 0.85, minPixels = 20, maxCandidates = 50000
}) {
    if (!Number.isFinite(maxMove) || maxMove < 0) {
        throw new Error(`maxMove must be a non-negative number. Got ${maxMove}.`);
    }
    if (!Number.isFinite(minSimilarity) || minSimilarity < 0 || minSimilarity > 1) {
        throw new Error(`minSimilarity must be between 0 and 1. Got ${minSimilarity}.`);
    }

    const eligible = regions.filter(r => r.pixels >= minPixels);
    if (eligible.length < 2) return {moves: [], pairs: new Map()};

    // bucket by bounding-box size; a translated block keeps its size, ±1 absorbs anti-alias growth
    /** @type {Map<string, Array<import('./regions.js').Region>>} */
    const bySize = new Map();
    for (const region of eligible) {
        for (let dw = -1; dw <= 1; dw++) {
            for (let dh = -1; dh <= 1; dh++) {
                const key = `${region.width + dw}x${region.height + dh}`;
                const bucket = bySize.get(key);
                if (bucket) bucket.push(region);
                else bySize.set(key, [region]);
            }
        }
    }

    /** @type {Array<{a: import('./regions.js').Region, b: import('./regions.js').Region, score: number}>} */
    const candidates = [];
    let sampled = 0;

    for (const a of eligible) {
        const bucket = bySize.get(`${a.width}x${a.height}`);
        if (!bucket) continue;

        for (const b of bucket) {
            if (b.id <= a.id) continue; // each unordered pair once
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            if (Math.abs(dx) > maxMove || Math.abs(dy) > maxMove) continue;
            if (dx === 0 && dy === 0) continue;

            const ratio = b.pixels / a.pixels;
            if (ratio < 0.85 || ratio > 1.15) continue;

            if (sampled >= maxCandidates) break;
            sampled++;

            const w = Math.min(a.width, b.width);
            const h = Math.min(a.height, b.height);
            const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 1024)));

            // cross-image comparison: this is what makes the link meaningful rather than a
            // coincidence of two similarly sized boxes
            const left = signature(img1, width, a.x, a.y, w, h, step);
            const right = signature(img2, width, b.x, b.y, w, h, step);
            const score = similarityOf(left, right);

            if (score >= minSimilarity) candidates.push({a, b, score});
        }
    }

    // greedy one-to-one assignment, best matches first; a region can participate in one link
    candidates.sort((x, y) => y.score - x.score);

    /** @type {Map<number, number>} */
    const pairs = new Map();
    /** @type {Move[]} */
    const moves = [];
    const used = new Set();

    for (const candidate of candidates) {
        if (used.has(candidate.a.id) || used.has(candidate.b.id)) continue;
        used.add(candidate.a.id);
        used.add(candidate.b.id);
        pairs.set(candidate.a.id, candidate.b.id);
        pairs.set(candidate.b.id, candidate.a.id);
        const dx = candidate.b.x - candidate.a.x;
        const dy = candidate.b.y - candidate.a.y;
        moves.push({
            a: candidate.a.id,
            b: candidate.b.id,
            dx,
            dy,
            distance: Math.round(Math.sqrt(dx * dx + dy * dy) * 100) / 100,
            similarity: Math.round(candidate.score * 1e4) / 1e4
        });
    }

    return {moves, pairs};
}
