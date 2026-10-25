/**
 * Draw region boxes and index labels onto a diff image.
 *
 * Kept dependency-free on purpose: the library only depends on `pngjs` for file I/O, and pulling
 * in a canvas or font stack just to draw a rectangle and a number would be a poor trade. Labels
 * use a 3×5 bitmap font, which is legible at 2× scale and adds no files to the package.
 */

/**
 * High-contrast hues that stay distinguishable on top of red/grey diff output.
 * @type {Array<[number, number, number]>}
 */
export const DEFAULT_PALETTE = [
    [0, 122, 255],
    [52, 199, 89],
    [255, 149, 0],
    [175, 82, 222],
    [48, 176, 199],
    [255, 45, 85],
    [99, 99, 102],
    [255, 214, 10]
];

// 3×5 glyphs, one string per row, '1' = ink.
/** @type {Record<string, string[]>} */
const DIGITS = {
    0: ['111', '101', '101', '101', '111'],
    1: ['010', '110', '010', '010', '111'],
    2: ['111', '001', '111', '100', '111'],
    3: ['111', '001', '111', '001', '111'],
    4: ['101', '101', '111', '001', '001'],
    5: ['111', '100', '111', '001', '111'],
    6: ['111', '100', '111', '101', '111'],
    7: ['111', '001', '001', '001', '001'],
    8: ['111', '101', '111', '101', '111'],
    9: ['111', '101', '111', '001', '111']
};

/**
 * @param {Uint8Array} pixels RGBA buffer, modified in place.
 * @param {number} width
 * @param {number} height
 * @param {number} x
 * @param {number} y
 * @param {[number, number, number]} color
 */
function putPixel(pixels, width, height, x, y, color) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const pos = (y * width + x) * 4;
    pixels[pos] = color[0];
    pixels[pos + 1] = color[1];
    pixels[pos + 2] = color[2];
    pixels[pos + 3] = 255;
}

/**
 * @param {Uint8Array} pixels
 * @param {number} width
 * @param {number} height
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 * @param {[number, number, number]} color
 * @param {number} [thickness=1]
 */
function strokeRect(pixels, width, height, x0, y0, x1, y1, color, thickness = 1) {
    for (let t = 0; t < thickness; t++) {
        for (let x = x0; x <= x1; x++) {
            putPixel(pixels, width, height, x, y0 + t, color);
            putPixel(pixels, width, height, x, y1 - t, color);
        }
        for (let y = y0; y <= y1; y++) {
            putPixel(pixels, width, height, x0 + t, y, color);
            putPixel(pixels, width, height, x1 - t, y, color);
        }
    }
}

/**
 * @param {Uint8Array} pixels
 * @param {number} width
 * @param {number} height
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 * @param {[number, number, number]} color
 */
function fillRect(pixels, width, height, x0, y0, x1, y1, color) {
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) putPixel(pixels, width, height, x, y, color);
    }
}

/**
 * Draw a positive integer with the bitmap font, returning the drawn width.
 * @param {Uint8Array} pixels
 * @param {number} width
 * @param {number} height
 * @param {number} x
 * @param {number} y
 * @param {number} value
 * @param {number} scale
 * @param {[number, number, number]} color
 */
function drawNumber(pixels, width, height, x, y, value, scale, color) {
    const text = String(value);
    const advance = 4 * scale; // 3px glyph + 1px gap
    for (let c = 0; c < text.length; c++) {
        const glyph = DIGITS[text[c]];
        if (!glyph) continue;
        for (let gy = 0; gy < 5; gy++) {
            const row = glyph[gy];
            for (let gx = 0; gx < 3; gx++) {
                if (row[gx] !== '1') continue;
                for (let sy = 0; sy < scale; sy++) {
                    for (let sx = 0; sx < scale; sx++) {
                        putPixel(pixels, width, height, x + c * advance + gx * scale + sx, y + gy * scale + sy, color);
                    }
                }
            }
        }
    }
    return text.length * advance;
}

/**
 * Return a new RGBA buffer with each region outlined and numbered.
 *
 * Boxes are drawn with a 1px outline plus short corner ticks, and a filled label chip sits just
 * above the box (or inside its top-left corner when there is no room above). Region `id` is used
 * as the label, matching the JSON report.
 *
 * @param {Uint8Array | Uint8ClampedArray} diff Source diff image (RGBA).
 * @param {number} width
 * @param {number} height
 * @param {Array<{id: number, x: number, y: number, width: number, height: number}>} regions
 * @param {object} [options]
 * @param {Array<[number, number, number]>} [options.palette]
 * @param {number} [options.scale=2] Bitmap font scale.
 * @param {number} [options.thickness=1] Box outline thickness.
 * @param {[number, number, number]} [options.textColor=[255, 255, 255]]
 * @param {[number, number, number]} [options.chipColor=[0, 0, 0]]
 * @return {Uint8Array}
 */
export function annotateDiff(diff, width, height, regions, {
    palette = DEFAULT_PALETTE,
    scale = 2,
    thickness = 1,
    textColor = [255, 255, 255],
    chipColor = [0, 0, 0]
} = {}) {
    const out = Uint8Array.from(diff);

    for (const region of regions) {
        const color = palette[(region.id - 1) % palette.length];

        const x0 = region.x;
        const y0 = region.y;
        const x1 = Math.min(width - 1, region.x + region.width - 1);
        const y1 = Math.min(height - 1, region.y + region.height - 1);

        // outline, then thicker corner ticks so boxes stay visible over busy diff colours
        strokeRect(out, width, height, x0, y0, x1, y1, color, thickness);
        const tick = Math.max(3, Math.round(Math.min(x1 - x0, y1 - y0) / 4));
        for (let t = 0; t < tick; t++) {
            putPixel(out, width, height, x0 + t, y0, color);
            putPixel(out, width, height, x1 - t, y0, color);
            putPixel(out, width, height, x0 + t, y1, color);
            putPixel(out, width, height, x1 - t, y1, color);
            putPixel(out, width, height, x0, y0 + t, color);
            putPixel(out, width, height, x1, y0 + t, color);
            putPixel(out, width, height, x0, y1 - t, color);
            putPixel(out, width, height, x1, y1 - t, color);
        }

        // label chip: above the box when possible, otherwise below it, otherwise inside the
        // top-left corner. Pick the first candidate whose rectangle does not overlap the box,
        // so the box outline is never covered (a box at the very top of the image has no room
        // above it at all).
        const digits = String(region.id).length;
        const chipW = digits * 4 * scale + 2;
        const chipH = 5 * scale + 2;
        const chipX = Math.max(0, Math.min(width - chipW, x0));

        const candidates = [y0 - chipH, y1 + 2, y0 + 1];
        /** @type {number | null} */
        let chipY = null;
        for (const candidate of candidates) {
            if (candidate < 0 || candidate + chipH - 1 > height - 1) continue;
            const overlapsBox = candidate <= y1 && candidate + chipH - 1 >= y0;
            if (overlapsBox) continue;
            chipY = candidate;
            break;
        }
        // fall back to the inside-top-left placement for boxes that fill the whole image
        if (chipY === null) {
            const inside = Math.min(height - chipH - 1, y0 + 1);
            if (inside < 0) continue;
            chipY = inside;
        }

        fillRect(out, width, height, chipX, chipY, chipX + chipW - 1, chipY + chipH - 1, chipColor);
        drawNumber(out, width, height, chipX + 1, chipY + 1, region.id, scale, textColor);
        strokeRect(out, width, height, chipX, chipY, chipX + chipW - 1, chipY + chipH - 1, color, 1);

        // the chip can sit directly above a region with no pixel of gap, in which case it covers
        // that region's top-left corner; redraw the box so the corner always shows its colour
        putPixel(out, width, height, x0, y0, color);
        putPixel(out, width, height, x0 + 1, y0, color);
        putPixel(out, width, height, x0, y0 + 1, color);
    }

    return out;
}
