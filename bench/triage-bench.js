/**
 * Measures the cost this fork adds on top of upstream pixelmatch.
 *
 * Methodology: every configuration runs the same fixtures in the same order; the reported number
 * is the MEDIAN of `ROUNDS` rounds after `WARMUP` warmups, and rounds alternate between
 * configurations so that a slow phase of the machine hits all of them instead of only whichever
 * one happens to run last. The 10th percentile is printed alongside the median because the
 * minimum-ish figure is the closest thing to a noise-free measurement on a shared CI machine.
 * A single timing can easily point the wrong way, so nothing here is concluded from one sample.
 * Run with `npm run bench`.
 */
import {PNG} from 'pngjs';
import fs from 'node:fs';
import pixelmatch from '../index.js';
import {compare} from '../triage.js';

const readImage = name => PNG.sync.read(fs.readFileSync(new URL(`../test/fixtures/${name}.png`, import.meta.url)));

const fixtures = [1, 2, 3, 4, 5, 6, 7].map(i => [readImage(`${i}a`), readImage(`${i}b`)]);

const ROUNDS = 40;
const WARMUP = 4;

const configs = [
    {
        name: 'upstream pixelmatch (baseline)',
        run: () => {
            let sum = 0;
            for (const [a, b] of fixtures) sum += pixelmatch(a.data, b.data, null, a.width, a.height);
            return sum;
        }
    },
    {
        name: 'compare(): core only (regions:false)',
        run: () => {
            let sum = 0;
            for (const [a, b] of fixtures) sum += compare(a.data, b.data, a.width, a.height, {regions: false}).diffPixels;
            return sum;
        }
    },
    {
        name: 'compare(): + regions',
        run: () => {
            let sum = 0;
            for (const [a, b] of fixtures) sum += compare(a.data, b.data, a.width, a.height).regions.length;
            return sum;
        }
    },
    {
        name: 'compare(): + regions + diff buffer',
        run: () => {
            let sum = 0;
            for (const [a, b] of fixtures) sum += compare(a.data, b.data, a.width, a.height, {diff: true}).regions.length;
            return sum;
        }
    },
    {
        name: 'compare(): + regions + annotate',
        run: () => {
            let sum = 0;
            for (const [a, b] of fixtures) sum += compare(a.data, b.data, a.width, a.height, {annotate: true}).regions.length;
            return sum;
        }
    },
    {
        name: 'compare(): + moves:false',
        run: () => {
            let sum = 0;
            for (const [a, b] of fixtures) sum += compare(a.data, b.data, a.width, a.height, {moves: false}).moves.length;
            return sum;
        }
    },
    {
        name: 'compare(): + align:auto',
        run: () => {
            let sum = 0;
            for (const [a, b] of fixtures) sum += compare(a.data, b.data, a.width, a.height, {align: 'auto'}).diffPixels;
            return sum;
        }
    }
];

/** @type {number[][]} */
const samples = configs.map(() => []);

for (let w = 0; w < WARMUP; w++) for (const config of configs) config.run();

for (let round = 0; round < ROUNDS; round++) {
    for (let c = 0; c < configs.length; c++) {
        const t0 = process.hrtime.bigint();
        configs[c].run();
        samples[c].push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
}

/** @param {number[]} values */
function percentile(values, q) {
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.floor(sorted.length * q);
    return sorted[Math.min(sorted.length - 1, Math.max(0, index))];
}

const baselineMedian = percentile(samples[0], 0.5);
const baselineP10 = percentile(samples[0], 0.1);
const totalPixels = fixtures.reduce((sum, [a]) => sum + a.width * a.height, 0);

console.log(`Fixtures: ${fixtures.length} pairs, ${totalPixels} pixels per round, ${ROUNDS} interleaved rounds after ${WARMUP} warmups
`);

for (let c = 0; c < configs.length; c++) {
    const med = percentile(samples[c], 0.5);
    const p10 = percentile(samples[c], 0.1);
    const ratioMed = c === 0 ? '-' : `${(med / baselineMedian).toFixed(2)}x`;
    const ratioP10 = c === 0 ? '-' : `${(p10 / baselineP10).toFixed(2)}x`;
    console.log(`p10 ${p10.toFixed(2).padStart(6)} ms (${ratioP10.padStart(6)})   median ${med.toFixed(2).padStart(7)} ms (${ratioMed.padStart(6)})   ${configs[c].name}`);
}
