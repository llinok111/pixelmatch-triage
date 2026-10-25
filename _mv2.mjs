import {compare} from './triage.js';

const W = 200, H = 140;
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

// case 1: same size, SAME content, moved 60px  -> must link
{
    const a = mk(), b = mk();
    rect(a, 10, 10, 40, 20, [0, 102, 204]);
    rect(b, 70, 10, 40, 20, [0, 102, 204]);
    const r = compare(a, b, W, H, {threshold: 0.05});
    console.log('same content moved  :', JSON.stringify(r.moves), 'summary', JSON.stringify(r.summary));
}

// case 2: same size, DIFFERENT content, same distance -> must NOT link
{
    const a = mk(), b = mk();
    rect(a, 10, 10, 40, 20, [0, 102, 204]);
    rect(b, 70, 10, 40, 20, [204, 51, 51]);
    const r = compare(a, b, W, H, {threshold: 0.05});
    console.log('different content   :', JSON.stringify(r.moves), 'summary', JSON.stringify(r.summary));
}

// case 3: same content, but 200px apart (beyond maxMove) -> must NOT link
{
    const a = mk(), b = mk();
    rect(a, 5, 10, 30, 20, [0, 102, 204]);
    rect(b, 165, 10, 30, 20, [0, 102, 204]);
    const r = compare(a, b, W, H, {threshold: 0.05});
    console.log('too far apart       :', JSON.stringify(r.moves));
}

// case 4: duplicate (copy) - same content present in BOTH images plus an extra copy -> must NOT
// be reported as a move, and this is exactly the ambiguity the module refuses to resolve
{
    const a = mk(), b = mk();
    rect(a, 10, 10, 30, 20, [0, 102, 204]);
    rect(b, 10, 10, 30, 20, [0, 102, 204]);
    rect(b, 100, 10, 30, 20, [0, 102, 204]);
    const r = compare(a, b, W, H, {threshold: 0.05});
    console.log('duplicate (copy)    :', JSON.stringify(r.moves), 'regions', r.regions.length);
}
