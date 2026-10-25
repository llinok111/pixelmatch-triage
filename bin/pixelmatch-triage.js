#!/usr/bin/env node

import {PNG} from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import {compare} from '../triage.js';

const USAGE = `Usage: pixelmatch-triage image1.png image2.png [options]

Reports what changed between two screenshots, grouped into ranked regions.
Exit codes follow the pixelmatch CLI: 0 match, 66 differ, 65 dimension mismatch, 64 bad usage.

Options:
  --diff <file>          Write the pixel diff PNG
  --annotated <file>     Write the diff PNG with numbered region boxes (implies --diff)
  --json <file>          Write the full report as JSON (- for stdout)
  --out-dir <dir>        Shorthand: write <name>-diff.png, <name>-annotated.png and <name>-report.json
  --name <name>          Base name used by --out-dir (default: image1 basename)
  --threshold <n>        Per-pixel threshold, 0-1 (default 0.1)
  --include-aa           Count anti-aliased pixels as differences
  --merge-gap <n>        Merge regions whose boxes are within n px (default 3)
  --min-pixels <n>       Drop regions with fewer differing pixels (default 1)
  --align                Estimate a global shift and compensate for it before comparing
  --max-shift <n>        Shift search radius in px (default 4)
  --psnr-min <n>         Fail (exit 66) when PSNR drops below n dB
  --quiet                Only print the summary line
  --help                 Show this message
`;

/**
 * @param {string[]} argv
 * @return {{positionals: string[], flags: Map<string, string | boolean>}}
 */
function parseArgs(argv) {
    /** @type {Map<string, string | boolean>} */
    const flags = new Map();
    /** @type {string[]} */
    const positionals = [];
    const valued = new Set(['--diff', '--annotated', '--json', '--out-dir', '--name', '--threshold', '--merge-gap', '--min-pixels', '--max-shift', '--psnr-min']);
    const booleanFlags = new Set(['--include-aa', '--align', '--quiet', '--help']);

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (valued.has(arg)) {
            const value = argv[++i];
            if (value === undefined) throw new Error(`Missing value for ${arg}`);
            flags.set(arg, value);
        } else if (booleanFlags.has(arg)) {
            flags.set(arg, true);
        } else if (arg.startsWith('--')) {
            throw new Error(`Unknown option ${arg}`);
        } else {
            positionals.push(arg);
        }
    }

    return {positionals, flags};
}

/** @param {Map<string, string | boolean>} flags @param {string} name @param {number} fallback */
function numberFlag(flags, name, fallback) {
    if (!flags.has(name)) return fallback;
    const raw = String(flags.get(name));
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${name} expects a number, got "${raw}"`);
    return value;
}

/** @param {string} p */
function readPng(p) {
    return PNG.sync.read(fs.readFileSync(p));
}

/** @param {number} value @param {number} digits */
const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

function main() {
    let parsed;
    try {
        parsed = parseArgs(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(`${/** @type {Error} */ (error).message}\n\n${USAGE}`);
        process.exit(64);
    }

    const {positionals, flags} = parsed;

    if (flags.has('--help') || positionals.length === 0) {
        process.stdout.write(USAGE);
        process.exit(positionals.length === 0 && !flags.has('--help') ? 64 : 0);
    }

    if (positionals.length !== 2) {
        process.stderr.write(`Expected 2 images, got ${positionals.length}.\n\n${USAGE}`);
        process.exit(64);
    }

    const [fileA, fileB] = positionals;

    let img1, img2;
    try {
        img1 = readPng(fileA);
        img2 = readPng(fileB);
    } catch (error) {
        // unreadable input is a usage problem, not a difference
        process.stderr.write(`Cannot read image: ${/** @type {Error} */ (error).message}\n`);
        process.exit(64);
    }

    if (img1.width !== img2.width || img1.height !== img2.height) {
        process.stdout.write(`Image dimensions do not match: ${img1.width}x${img1.height} vs ${img2.width}x${img2.height}\n`);
        process.exit(65);
    }

    const {width, height} = img1;

    let options;
    try {
        options = {
            threshold: numberFlag(flags, '--threshold', 0.1),
            includeAA: flags.has('--include-aa'),
            mergeGap: numberFlag(flags, '--merge-gap', 3),
            minPixels: numberFlag(flags, '--min-pixels', 1),
            align: flags.has('--align') ? 'auto' : 'none',
            maxShift: numberFlag(flags, '--max-shift', 4),
            diff: true
        };
    } catch (error) {
        process.stderr.write(`${/** @type {Error} */ (error).message}\n`);
        process.exit(64);
    }

    const wantAnnotated = flags.has('--annotated') || flags.has('--out-dir');
    const started = process.hrtime.bigint();

    const result = compare(img1.data, img2.data, width, height, {
        threshold: options.threshold,
        includeAA: options.includeAA,
        regions: {mergeGap: options.mergeGap, minPixels: options.minPixels},
        align: options.align,
        maxShift: options.maxShift,
        diff: true,
        annotate: wantAnnotated
    });

    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    // figure out output paths
    const outDir = flags.has('--out-dir') ? String(flags.get('--out-dir')) : null;
    const baseName = flags.has('--name') ?
        String(flags.get('--name')) :
        path.basename(fileA).replace(/\.png$/i, '');

    if (outDir) fs.mkdirSync(outDir, {recursive: true});

    /** @type {Record<string, string>} */
    const written = {};

    const diffPath = flags.has('--diff') ? String(flags.get('--diff')) : (outDir ? path.join(outDir, `${baseName}-diff.png`) : null);
    if (diffPath && result.diff) {
        fs.writeFileSync(diffPath, PNG.sync.write({width, height, data: Buffer.from(result.diff)}));
        written.diff = diffPath;
    }

    const annotatedPath = flags.has('--annotated') ? String(flags.get('--annotated')) : (outDir ? path.join(outDir, `${baseName}-annotated.png`) : null);
    if (annotatedPath && result.annotated) {
        fs.writeFileSync(annotatedPath, PNG.sync.write({width, height, data: Buffer.from(result.annotated)}));
        written.annotated = annotatedPath;
    }

    const report = {
        source: {
            a: path.basename(fileA),
            b: path.basename(fileB),
            width,
            height
        },
        summary: {
            diffPixels: result.diffPixels,
            totalPixels: result.totalPixels,
            diffRatio: result.diffRatio,
            percentChanged: round(result.diffRatio * 100, 3),
            aaPixels: result.aaPixels,
            ignoredPixels: result.ignoredPixels,
            psnr: result.psnr,
            components: result.components,
            regions: result.regions.length
        },
        shift: result.shift,
        regions: result.regions.map(r => ({
            id: r.id,
            box: {x: r.x, y: r.y, width: r.width, height: r.height},
            pixels: r.pixels,
            density: round(r.density, 4),
            coverage: round(r.coverage, 6),
            diffuse: r.diffuse,
            meanDelta: round(r.meanDelta, 4),
            maxDelta: round(r.maxDelta, 4),
            kind: r.kind,
            meanColorA: r.meanColorA,
            meanColorB: r.meanColorB
        })),
        options: {
            threshold: options.threshold,
            includeAA: options.includeAA,
            mergeGap: options.mergeGap,
            minPixels: options.minPixels,
            align: options.align,
            maxShift: options.maxShift
        },
        files: written,
        elapsedMs: round(elapsedMs, 2)
    };

    const jsonTarget = flags.has('--json') ? String(flags.get('--json')) : (outDir ? path.join(outDir, `${baseName}-report.json`) : null);
    const jsonText = `${JSON.stringify(report, null, 2)}\n`;
    const jsonToStdout = jsonTarget === '-';
    if (jsonToStdout) {
        process.stdout.write(jsonText);
    } else if (jsonTarget) {
        fs.writeFileSync(jsonTarget, jsonText);
        written.json = jsonTarget;
    }

    // machine output owns stdout: when the report goes to `-`, the human summary must not
    // corrupt it, so it is suppressed entirely rather than redirected
    const quiet = flags.has('--quiet') || jsonToStdout;

    if (!quiet) {
        const summary = report.summary;
        process.stdout.write(`${summary.diffPixels} of ${summary.totalPixels} pixels differ (${summary.percentChanged}%), PSNR ${summary.psnr ?? 'n/a'} dB\n`);
        process.stdout.write(`${summary.regions} region(s) from ${summary.components} raw component(s)${summary.aaPixels ? `, ${summary.aaPixels} anti-aliased pixels ignored` : ''}\n`);

        if (result.shift.applied) {
            process.stdout.write(`aligned: shifted image 2 by (${-result.shift.dx}, ${-result.shift.dy}) px to match\n`);
        }

        for (const region of result.regions) {
            const where = `(${region.x},${region.y}) ${region.width}x${region.height}`;
            const strength = `mean Δ${region.meanDelta.toFixed(3)} max Δ${region.maxDelta.toFixed(3)}`;
            const solid = region.diffuse ? 'diffuse' : 'solid';
            process.stdout.write(`  #${String(region.id).padStart(2)} ${where}  ${String(region.pixels).padStart(6)} px  ${solid}  ${region.kind.padEnd(7)}  ${strength}\n`);
        }

        for (const [kind, file] of Object.entries(written)) {
            process.stdout.write(`${kind}: ${file}\n`);
        }

        process.stdout.write(`elapsed: ${report.elapsedMs} ms\n`);
    }

    const psnrMin = flags.has('--psnr-min') ? numberFlag(flags, '--psnr-min', 0) : null;
    const psnrFailed = psnrMin !== null && result.psnr !== null && result.psnr < psnrMin;

    process.exit(result.diffPixels > 0 || psnrFailed ? 66 : 0);
}

main();
