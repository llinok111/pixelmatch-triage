/**
 * Reproduction of the problem this fork exists to solve.
 *
 * Two regression screenshots are compared against the same baseline. They differ in KIND rather
 * than in volume:
 *
 *   A. the developer moved the primary button 140 px (one intended change),
 *   B. a rendering artefact left faint specks spread over a 160x180 area (no intended change).
 *
 * A count-only check sees "a few thousand pixels" in both and cannot say which one a reviewer
 * should look at. Run with `node examples/scenario.mjs`.
 */
import {compare} from '../triage.js';
import pixelmatch from '../index.js';

const WIDTH = 480;
const HEIGHT = 320;

const BG = [248, 249, 250];

const canvas = () => {
    const data = new Uint8Array(WIDTH * HEIGHT * 4);
    for (let i = 0; i < WIDTH * HEIGHT; i++) {
        data[i * 4] = BG[0];
        data[i * 4 + 1] = BG[1];
        data[i * 4 + 2] = BG[2];
        data[i * 4 + 3] = 255;
    }
    return data;
};

const rect = (data, x, y, w, h, color) => {
    for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
            if (xx < 0 || yy < 0 || xx >= WIDTH || yy >= HEIGHT) continue;
            const p = (yy * WIDTH + xx) * 4;
            data[p] = color[0];
            data[p + 1] = color[1];
            data[p + 2] = color[2];
            data[p + 3] = 255;
        }
    }
};

const nudge = (data, x, y, delta) => {
    const p = (y * WIDTH + x) * 4;
    data[p] = Math.max(0, data[p] - delta);
    data[p + 1] = Math.max(0, data[p + 1] - delta);
    data[p + 2] = Math.max(0, data[p + 2] - delta);
};

const INK = [33, 37, 41];
const MUTED = [134, 142, 150];
const ACCENT = [0, 102, 204];
const FIELD = [222, 226, 230];

// a small settings panel
const baseline = canvas();
rect(baseline, 24, 20, 200, 12, INK);
rect(baseline, 24, 56, 120, 8, MUTED);
rect(baseline, 24, 88, 180, 36, FIELD);
rect(baseline, 24, 140, 180, 36, FIELD);
rect(baseline, 300, 88, 36, 36, ACCENT);
rect(baseline, 300, 140, 36, 36, MUTED);
rect(baseline, 24, 260, 90, 30, ACCENT);

// A: the primary button now sits 140 px to the right
const moved = Uint8Array.from(baseline);
rect(moved, 24, 260, 90, 30, BG);
rect(moved, 164, 260, 90, 30, ACCENT);

// B: faint specks spread over the settings field, 3 px apart
const speckle = Uint8Array.from(baseline);
const SPECKLE_BOX = {x0: 20, y0: 80, x1: 240, y1: 180};
for (let y = SPECKLE_BOX.y0; y < SPECKLE_BOX.y1; y += 3) {
    for (let x = SPECKLE_BOX.x0; x < SPECKLE_BOX.x1; x += 3) {
        nudge(speckle, x, y, 34);
    }
}

const row = (label, value) => `  ${label.padEnd(30)}${value}`;

const cases = [
    ['A  primary button moved 140 px', moved, 'one intended change'],
    ['B  faint specks over a 220x100 field', speckle, 'no intended change']
];

for (const [title, image, note] of cases) {
    const count = pixelmatch(baseline, image, null, WIDTH, HEIGHT, {threshold: 0.05});
    const result = compare(baseline, image, WIDTH, HEIGHT, {threshold: 0.05});
    const solid = result.regions.filter((r) => !r.diffuse);
    const diffuse = result.regions.filter((r) => r.diffuse);
    const solidPixels = solid.reduce((sum, r) => sum + r.pixels, 0);
    const largest = result.regions.reduce((a, b) => (b.pixels > a.pixels ? b : a));

    console.log(`\n${title}   (${note})`);
    console.log(row('pixels differing (upstream)', count));
    console.log(row('regions after merging', result.regions.length));
    console.log(row('solid / diffuse regions', `${solid.length} / ${diffuse.length}`));
    console.log(row('pixels inside solid regions', solidPixels));
    console.log(row('largest region', `${largest.width}x${largest.height} at (${largest.x},${largest.y}), ${largest.pixels} px, mean Δ${largest.meanDelta.toFixed(3)}`));
    console.log(row('PSNR', `${result.psnr} dB`));
}

console.log(`
Read it as: case A puts its pixels into solid blocks (100% density) with a strong mean colour
distance, which is what a relocated control looks like. Case B spreads thousands of pixels over a
wide field at a few percent density with weak colour distance and no solid block at all, which is
what a rendering artefact looks like. The upstream pixel count is only a volume: it reports
"5400" and "2516" without saying that one is a moved button and the other is noise. The region
report carries the shape, which is the part a reviewer actually acts on.
`);

