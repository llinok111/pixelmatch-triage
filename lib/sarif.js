/**
 * SARIF 2.1.0 output for a comparison report.
 *
 * The point is placement: GitHub code scanning renders SARIF results on the changed file at the
 * given line, so a regression shows up where a reviewer is already looking instead of in a log
 * they have to scroll. Diff results have no natural source line, so this maps each region to the
 * line of the compared file by proportional height, which is the closest honest approximation
 * available and is documented as such.
 *
 * The schema is fixed by OASIS; this emits the subset GitHub renders, not a full implementation.
 */

const SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
const TOOL_NAME = 'pixelmatch-triage';
/** Kept in sync with package.json by a test, so SARIF consumers see the real producer version. */
export const TOOL_VERSION = '0.2.0';
const RULE_ID = 'visual-regression';

/**
 * @param {any} report A `compare()` result (kept loose to avoid a circular type import).
 * @param {object} [options]
 * @param {string} [options.uri='after.png'] Repository-relative path of the compared image.
 * @param {number} [options.sourceLines=0] Line count to map regions onto; 0 emits no line info.
 * @param {string} [options.level='warning'] SARIF result level.
 * @param {number} [options.maxResults=100] Cap on emitted results (the region list is ranked, so the cap keeps the strongest).
 * @return {object} A SARIF log object, ready for `JSON.stringify`.
 */
export function toSarif(report, {
    uri = 'after.png',
    sourceLines = 0,
    level = 'warning',
    maxResults = 100
} = {}) {
    if (!Number.isInteger(maxResults) || maxResults < 1) {
        throw new Error(`maxResults must be a positive integer. Got ${maxResults}.`);
    }
    if (!['none', 'note', 'warning', 'error'].includes(level)) {
        throw new Error(`level must be one of none/note/warning/error. Got ${level}.`);
    }

    const regions = report.regions.slice(0, maxResults);

    /** @type {Array<any>} */
    const results = regions.map((/** @type {any} */ region) => {
        const text = describe(region);
        /** @type {object} */
        /** @type {any} */
        const physicalLocation = {
            artifactLocation: {uri}
        };

        // proportional vertical mapping: a box at 40% of the image height points at 40% of the file
        if (sourceLines > 0 && report.height > 0) {
            const centre = region.y + region.height / 2;
            const line = Math.max(1, Math.min(sourceLines, Math.ceil((centre / report.height) * sourceLines)));
            physicalLocation.region = {
                startLine: line,
                startColumn: region.x + 1,
                endLine: line,
                endColumn: region.x + region.width
            };
        }

        return {
            ruleId: RULE_ID,
            level,
            message: {text},
            locations: [{physicalLocation}],
            properties: {
                regionId: region.id,
                box: {x: region.x, y: region.y, width: region.width, height: region.height},
                pixels: region.pixels,
                density: region.density,
                coverage: region.coverage,
                diffuse: region.diffuse,
                kind: region.kind,
                meanDelta: region.meanDelta,
                maxDelta: region.maxDelta,
                linkedTo: region.counterpart ?? null
            }
        };
    });

    const ruleDescription = [
        `${report.diffPixels} of ${report.totalPixels} pixels differ`,
        `${report.regions.length} region(s)`,
        report.moves && report.moves.length > 0 ? `${report.moves.length} linked pair(s)` : null,
        report.psnr === null ? 'identical' : `PSNR ${report.psnr} dB`
    ].filter(Boolean).join('; ');

    return {
        $schema: SCHEMA,
        version: '2.1.0',
        runs: [
            {
                tool: {
                    driver: {
                        name: TOOL_NAME,
                        version: TOOL_VERSION,
                        informationUri: 'https://github.com/llinok111/pixelmatch-triage',
                        rules: [
                            {
                                id: RULE_ID,
                                name: 'VisualRegression',
                                shortDescription: {text: 'Visually different region between two images'},
                                fullDescription: {text: ruleDescription},
                                defaultConfiguration: {level}
                            }
                        ]
                    }
                },
                results,
                invocations: [
                    {
                        executionSuccessful: true,
                        properties: {
                            threshold: report.options.threshold,
                            mergeGap: report.options.mergeGap,
                            align: report.options.align
                        }
                    }
                ]
            }
        ]
    };
}

/**
 * One-line human description of a region, reused by the CLI and the SARIF message.
 * @param {import('./regions.js').Region} region
 * @return {string}
 */
export function describe(region) {
    const shape = region.diffuse ? 'diffuse' : 'solid';
    const linked = region.counterpart !== null && region.counterpart !== undefined ?
        `, same content as region ${region.counterpart}` :
        '';
    return `region ${region.id}: ${region.width}x${region.height} at (${region.x}, ${region.y}), ` +
        `${region.pixels} px, ${shape}, ${region.kind}, mean Δ${region.meanDelta.toFixed(3)}${linked}`;
}
