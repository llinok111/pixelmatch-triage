export type RegionKind = 'added' | 'removed' | 'mixed';

export interface Region {
    /** 1-based rank, ordered by visual weight (descending). */
    id: number;
    x: number;
    y: number;
    width: number;
    height: number;
    pixels: number;
    density: number;
    coverage: number;
    diffuse: boolean;
    meanDelta: number;
    maxDelta: number;
    weight: number;
    kind: RegionKind;
    meanColorA: [number, number, number];
    meanColorB: [number, number, number];
    /** Set when the region shares its content with another region. */
    moved?: 'linked' | null;
    /** Id of the region holding the same content elsewhere. */
    counterpart?: number | null;
    move?: Move | null;
}

export interface Move {
    /** Id of the first region (always the smaller id). */
    a: number;
    b: number;
    /** `b.x - a.x`, in pixels. Direction is a presentation convention, not an inference. */
    dx: number;
    dy: number;
    distance: number;
    /** 0–1; 1 means the sampled content matches exactly. */
    similarity: number;
}

export interface RegionSummary {
    added: number;
    removed: number;
    mixed: number;
    /** Number of linked pairs. */
    moved: number;
    /** Regions that are not part of a link. */
    modified: number;
}

export interface ShiftReport {
    detected: boolean;
    dx: number;
    dy: number;
    gain: number;
    confidence: number;
    applied: boolean;
    maxShift: number;
}

export interface CompareOptions {
    threshold?: number;
    includeAA?: boolean;
    checkerboard?: boolean;
    ignoreMask?: Uint8Array | Uint8ClampedArray;
    windowSize?: number;
    regions?: boolean | {mergeGap?: number; minPixels?: number};
    align?: 'none' | 'auto';
    detectShift?: boolean;
    maxShift?: number;
    minShiftGain?: number;
    diff?: boolean;
    annotate?: boolean;
    moves?: boolean;
    /** 0 or omitted means auto: half the larger image dimension, minimum 96 px. */
    maxMove?: number;
    minMoveSimilarity?: number;
    minMovePixels?: number;
    alpha?: number;
    aaColor?: [number, number, number];
    diffColor?: [number, number, number];
    diffColorAlt?: [number, number, number];
    diffMask?: boolean;
}

export interface CompareResult {
    width: number;
    height: number;
    totalPixels: number;
    diffPixels: number;
    diffRatio: number;
    ignoredPixels: number;
    aaPixels: number;
    psnr: number | null;
    shift: ShiftReport;
    regions: Region[];
    moves: Move[];
    summary: RegionSummary;
    diff: Uint8Array | null;
    annotated: Uint8Array | null;
    coreCount: number;
    components: number;
    options: {
        threshold: number;
        includeAA: boolean;
        checkerboard: boolean;
        mergeGap: number;
        minPixels: number;
        windowSize: number;
        align: 'none' | 'auto';
    };
}

export function compare(
    img1: Uint8Array | Uint8ClampedArray,
    img2: Uint8Array | Uint8ClampedArray,
    width: number,
    height: number,
    options?: CompareOptions
): CompareResult;

export interface ShiftEstimate {
    dx: number;
    dy: number;
    cost: number;
    baselineCost: number;
    gain: number;
    confidence: number;
    overlap: number;
}

export function estimateShift(
    img1: Uint8Array | Uint8ClampedArray,
    img2: Uint8Array | Uint8ClampedArray,
    width: number,
    height: number,
    options?: {maxShift?: number; minOverlap?: number}
): ShiftEstimate;

export function shiftPixels(
    src: Uint8Array | Uint8ClampedArray,
    width: number,
    height: number,
    dx: number,
    dy: number
): Uint8Array;

export function shiftMask(
    src: Uint8Array | Uint8ClampedArray,
    width: number,
    height: number,
    dx: number,
    dy: number
): Uint8Array;

export function annotateDiff(
    diff: Uint8Array | Uint8ClampedArray,
    width: number,
    height: number,
    regions: Array<{id: number; x: number; y: number; width: number; height: number}>,
    options?: {
        palette?: Array<[number, number, number]>;
        scale?: number;
        thickness?: number;
        textColor?: [number, number, number];
        chipColor?: [number, number, number];
    }
): Uint8Array;

export interface SarifOptions {
    /** Repository-relative path of the compared image. */
    uri?: string;
    /** Map regions onto this many lines; 0 emits no line information. */
    sourceLines?: number;
    level?: 'none' | 'note' | 'warning' | 'error';
    maxResults?: number;
}

export function toSarif(report: CompareResult, options?: SarifOptions): object;

export function describe(region: Region): string;

export function detectMoves(input: {
    regions: Region[];
    img1: Uint8Array | Uint8ClampedArray;
    img2: Uint8Array | Uint8ClampedArray;
    width: number;
    /** 0 or omitted means auto: half the larger image dimension, minimum 96 px. */
    maxMove?: number;
    minSimilarity?: number;
    minPixels?: number;
    maxCandidates?: number;
}): {moves: Move[]; pairs: Map<number, number>};
