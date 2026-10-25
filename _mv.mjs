import {compare} from './triage.js';

const W = 200, H = 120;
const mk = () => {
    const d = new Uint8Array(W * H * 4).fill(255);
    for (let i = 3; i < d.length; i += 4) d[i] = 255;
    return d;
};
const rect = (d, x, y, w, h, c) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
        const p = (yy * W + xx) * 4;
        d[p] = c[0]; d[p + 1] = c[1]; d[p + 2] = c[2]; d[p + 3] = 255;
    }
};

const a = mk(), b = mk();
rect(a, 10, 10, 30, 14, [0, 102, 204]);
rect(a, 10, 50, 20, 10, [33, 37, 41]);
rect(b, 90, 10, 30, 14, [0, 102, 204]);
rect(b, 10, 50, 20, 10, [33, 37, 41]);

const r = compare(a, b, W, H, {threshold: 0.05});
console.log('regions', r.regions.map(g => `#${g.id} ${g.kind} ${g.width}x${g.height}@(${g.x},${g.y}) moved=${g.moved} cp=${g.counterpart}`));
console.log('moves', JSON.stringify(r.moves));
console.log('summary', JSON.stringify(r.summary));
