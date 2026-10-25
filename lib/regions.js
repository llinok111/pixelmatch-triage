/**
 * Turn a per-pixel diff classification into human-triageable regions.
 *
 * Upstream pixelmatch returns a single number, so a CI failure says "36563 pixels changed" and
 * leaves the reader to eyeball a diff image. This module keeps the same pixel classification but
 * groups neighbouring diff pixels into connected components, optionally bridges small gaps (text
 * strokes and icon details are rarely one solid blob), and reports the geometry and strength of
 * each group.
 */

// 8-connectivity: diagonal neighbours belong to the same visual change.
const NEIGHBOUR_X = [-1, 0, 1, -1, 1, -1, 0, 1];
const NEIGHBOUR_Y = [-1, -1, -1, 0, 0, 1, 1, 1];

/**
 * @typedef {object} RawComponent
 * @property {number} label 1-based label.
 * @property {number} pixels Number of diff pixels.
 * @property {number} minX
 * @property {number} minY
 * @property {number} maxX
 * @property {number} maxY
 */

/**
 * Flood-fill the diff mask into 8-connected components.
 *
 * Uses an explicit stack (no recursion) sized to the pixel count, so deep components cannot blow
 * the call stack. Each pixel is labelled when it is pushed, which guarantees it is pushed at most
 * once and keeps the stack within `width * height` entries.
 *
 * @param {Uint8Array} classMap Per-pixel classification (1 = differing).
 * @param {number} width
 * @param {number} height
 * @return {{labels: Int32Array, components: RawComponent[]}}
 */
export function labelComponents(classMap, width, height) {
    const len = width * height;
    const labels = new Int32Array(len);
    const stack = new Int32Array(len);
    /** @type {RawComponent[]} */
    const components = [];
    let nextLabel = 0;

    for (let start = 0; start < len; start++) {
        if (classMap[start] !== 1 || labels[start] !== 0) continue;

        nextLabel++;
        let top = 0;
        stack[top++] = start;
        labels[start] = nextLabel;

        let pixels = 0;
        let minX = width;
        let minY = height;
        let maxX = -1;
        let maxY = -1;

        while (top > 0) {
            const i = stack[--top];
            const x = i % width;
            const y = (i - x) / width;

            pixels++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;

            for (let d = 0; d < 8; d++) {
                const nx = x + NEIGHBOUR_X[d];
                const ny = y + NEIGHBOUR_Y[d];
                if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                const j = ny * width + nx;
                if (classMap[j] === 1 && labels[j] === 0) {
                    labels[j] = nextLabel;
                    stack[top++] = j;
                }
            }
        }

        components.push({label: nextLabel, pixels, minX, minY, maxX, maxY});
    }

    return {labels, components};
}

/**
 * Largest per-axis gap between two bounding boxes (0 when they touch or overlap).
 * @param {RawComponent} a
 * @param {RawComponent} b
 * @return {number}
 */
function bboxGap(a, b) {
    const gapX = a.maxX < b.minX ? b.minX - a.maxX - 1 : (b.maxX < a.minX ? a.minX - b.maxX - 1 : 0);
    const gapY = a.maxY < b.minY ? b.minY - a.maxY - 1 : (b.maxY < a.minY ? a.minY - b.maxY - 1 : 0);
    return Math.max(gapX, gapY);
}

/**
 * Merge components whose bounding boxes are at most `mergeGap` pixels apart.
 *
 * Pairs are found through a uniform grid instead of comparing every component with every other
 * one: expanded bounding boxes of two nearby components must overlap, and overlapping rectangles
 * always share at least one grid cell. That keeps a noisy screenshot with thousands of speckles
 * from turning into a quadratic scan.
 *
 * @param {RawComponent[]} components
 * @param {number} mergeGap
 * @return {Int32Array} Union-find roots, one per component index.
 */
function mergeComponents(components, mergeGap) {
    const count = components.length;
    const parent = new Int32Array(count);
    for (let i = 0; i < count; i++) parent[i] = i;

    /** @type {(i: number) => number} */
    const find = (i) => {
        let root = i;
        while (parent[root] !== root) root = parent[root];
        let node = i;
        while (parent[node] !== root) {
            const next = parent[node];
            parent[node] = root;
            node = next;
        }
        return root;
    };

    /** @type {(a: number, b: number) => void} */
    const union = (a, b) => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
    };

    if (mergeGap <= 0) {
        // 8-connectivity already merges everything that touches, so only exact bbox sharing
        // (gap 0) could add pairs; those are impossible without diagonal contact.
        return parent;
    }

    const cellSize = mergeGap + 1;
    /** @type {Map<number, number[]>} */
    const grid = new Map();

    for (let i = 0; i < count; i++) {
        const c = components[i];
        const x0 = Math.floor((c.minX - mergeGap) / cellSize);
        const x1 = Math.floor((c.maxX + mergeGap) / cellSize);
        const y0 = Math.floor((c.minY - mergeGap) / cellSize);
        const y1 = Math.floor((c.maxY + mergeGap) / cellSize);
        for (let cy = y0; cy <= y1; cy++) {
            for (let cx = x0; cx <= x1; cx++) {
                const key = cy * 46341 + cx; // odd multiplier keeps (x, y) keys distinct in practice
                const bucket = grid.get(key);
                if (bucket) bucket.push(i);
                else grid.set(key, [i]);
            }
        }
    }

    for (const bucket of grid.values()) {
        if (bucket.length < 2) continue;
        for (let i = 0; i < bucket.length; i++) {
            for (let j = i + 1; j < bucket.length; j++) {
                const a = bucket[i];
                const b = bucket[j];
                if (find(a) === find(b)) continue;
                if (bboxGap(components[a], components[b]) <= mergeGap) union(a, b);
            }
        }
    }

    return parent;
}

/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));

/**
 * Accumulator used while folding labelled pixels into regions.
 * @typedef {object} Aggregate
 * @property {number} pixels
 * @property {number} minX
 * @property {number} minY
 * @property {number} maxX
 * @property {number} maxY
 * @property {number} sumDelta
 * @property {number} maxDelta
 * @property {number} sumR1
 * @property {number} sumG1
 * @property {number} sumB1
 * @property {number} sumR2
 * @property {number} sumG2
 * @property {number} sumB2
 * @property {number} brighter
 * @property {number} darker
 */

/**
 * @typedef {object} Region
 * @property {number} id 1-based, ordered by visual weight (descending).
 * @property {number} x Bounding box left.
 * @property {number} y Bounding box top.
 * @property {number} width Bounding box width.
 * @property {number} height Bounding box height.
 * @property {number} pixels Number of differing pixels inside the box.
 * @property {number} density `pixels / (width * height)` of the box, i.e. how solid the change is.
 * @property {number} coverage `pixels / (imageWidth * imageHeight)`, how much of the whole image the region covers.
 * @property {boolean} diffuse True when density < 0.35 (sparse network of changes, not one solid block).
 * @property {number} meanDelta Mean OKLab HyAB distance of its pixels.
 * @property {number} maxDelta Strongest HyAB distance in the region.
 * @property {number} weight `pixels * meanDelta`, the ranking key.
 * @property {'added' | 'removed' | 'mixed'} kind Whether img2 is mostly lighter, darker, or both.
 * @property {[number, number, number]} meanColorA Mean RGB in img1.
 * @property {[number, number, number]} meanColorB Mean RGB in img2.
 */

/**
 * @param {object} input
 * @param {Uint8Array} input.classMap
 * @param {Float32Array | null} input.deltas
 * @param {Uint8Array | Uint8ClampedArray} input.img1
 * @param {Uint8Array | Uint8ClampedArray} input.img2
 * @param {number} input.width
 * @param {number} input.height
 * @param {number} [input.mergeGap=3] Maximum bbox gap (px) that still merges two components.
 * @param {number} [input.minPixels=1] Drop regions with fewer differing pixels.
 * @return {{regions: Region[], components: number, mergedRegions: number, differing: number}}
 */
export function extractRegions({
    classMap, deltas, img1, img2, width, height, mergeGap = 3, minPixels = 1
}) {
    const {labels, components} = labelComponents(classMap, width, height);
    if (components.length === 0) return {regions: [], components: 0, mergedRegions: 0, differing: 0};

    const parent = mergeComponents(components, mergeGap);

    // aggregate per union-find root
    const aggregates = new Map();
    /** @type {(root: number) => import('./regions.js').Aggregate} */
    const ensure = (root) => {
        let agg = aggregates.get(root);
        if (!agg) {
            agg = {
                pixels: 0,
                minX: width,
                minY: height,
                maxX: -1,
                maxY: -1,
                sumDelta: 0,
                maxDelta: 0,
                sumR1: 0, sumG1: 0, sumB1: 0,
                sumR2: 0, sumG2: 0, sumB2: 0,
                brighter: 0,
                darker: 0
            };
            aggregates.set(root, agg);
        }
        return agg;
    };

    const len = width * height;
    let differing = 0;

    for (let i = 0; i < len; i++) {
        if (classMap[i] !== 1) continue;
        differing++;

        const label = labels[i];
        const root = findRoot(parent, label - 1);
        const agg = ensure(root);

        const pos = i * 4;
        const r1 = img1[pos], g1 = img1[pos + 1], b1 = img1[pos + 2];
        const r2 = img2[pos], g2 = img2[pos + 1], b2 = img2[pos + 2];

        const x = i % width;
        const y = (i - x) / width;

        agg.pixels++;
        if (x < agg.minX) agg.minX = x;
        if (x > agg.maxX) agg.maxX = x;
        if (y < agg.minY) agg.minY = y;
        if (y > agg.maxY) agg.maxY = y;

        if (deltas) {
            const d = deltas[i];
            agg.sumDelta += d;
            if (d > agg.maxDelta) agg.maxDelta = d;
        }

        agg.sumR1 += r1; agg.sumG1 += g1; agg.sumB1 += b1;
        agg.sumR2 += r2; agg.sumG2 += g2; agg.sumB2 += b2;

        // Rec.601 luma, matching the shortcut brightness test used by the library elsewhere.
        const luma1 = r1 * 0.29889531 + g1 * 0.58662247 + b1 * 0.11448223;
        const luma2 = r2 * 0.29889531 + g2 * 0.58662247 + b2 * 0.11448223;
        if (luma2 > luma1 + 1) agg.brighter++;
        else if (luma2 < luma1 - 1) agg.darker++;
    }

    /** @type {Region[]} */
    const regions = [];

    for (const agg of aggregates.values()) {
        if (agg.pixels < minPixels) continue;

        const w = agg.maxX - agg.minX + 1;
        const h = agg.maxY - agg.minY + 1;
        const meanDelta = deltas ? agg.sumDelta / agg.pixels : 0;
        const brightShare = agg.brighter / agg.pixels;
        const kind = brightShare >= 0.7 ? 'added' : (brightShare <= 0.3 ? 'removed' : 'mixed');
        const density = clamp(agg.pixels / (w * h), 0, 1);

        regions.push({
            id: 0,
            x: agg.minX,
            y: agg.minY,
            width: w,
            height: h,
            pixels: agg.pixels,
            density,
            // low-density regions are a sparse network of changes (dithered gradients, scattered
            // single-pixel shifts) rather than one solid block; a bounding box overstates them,
            // so callers should lean on `pixels` instead of the box area
            coverage: clamp(agg.pixels / (width * height), 0, 1),
            diffuse: density < 0.35,
            meanDelta,
            maxDelta: agg.maxDelta,
            weight: agg.pixels * meanDelta,
            kind,
            meanColorA: [
                Math.round(agg.sumR1 / agg.pixels),
                Math.round(agg.sumG1 / agg.pixels),
                Math.round(agg.sumB1 / agg.pixels)
            ],
            meanColorB: [
                Math.round(agg.sumR2 / agg.pixels),
                Math.round(agg.sumG2 / agg.pixels),
                Math.round(agg.sumB2 / agg.pixels)
            ]
        });
    }

    regions.sort((a, b) => (b.weight - a.weight) || (b.pixels - a.pixels) || (a.y - b.y) || (a.x - b.x));

    for (let i = 0; i < regions.length; i++) regions[i].id = i + 1;

    return {
        regions,
        components: components.length,
        mergedRegions: regions.length,
        differing
    };
}

/** @param {Int32Array} parent @param {number} i */
function findRoot(parent, i) {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    while (parent[i] !== root) {
        const next = parent[i];
        parent[i] = root;
        i = next;
    }
    return root;
}
