/**
 * Domain contracts for the Bambu Studio companion MCP.
 *
 * This layer knows nothing about the file system, child processes or the network; every external
 * capability is defined by ports and implemented by adapters.
 */

/** The three Bambu Studio preset kinds. */
export type PresetKind = 'machine' | 'process' | 'filament';

export const PRESET_KINDS: readonly PresetKind[] = ['machine', 'process', 'filament'];

/** Where a preset comes from: the system vendor directory or the user directory. */
export type PresetOrigin = 'system' | 'user';

/**
 * A raw preset value is always a string or an array of strings (arrays for multi-nozzle printers);
 * a few metadata fields are plain strings. No type narrowing happens here; the catalog interprets values.
 */
export type PresetValue = string | readonly string[];

export type PresetRecord = Readonly<Record<string, PresetValue>>;

/** A preset index entry: identity and location only, no contents. */
export type PresetIndexEntry = {
  readonly name: string;
  readonly kind: PresetKind;
  readonly origin: PresetOrigin;
  /** Path relative to the data root, only for humans to locate the file and debug. */
  readonly relativePath: string;
  /** Whether it can be selected directly in the UI; `false` means it is only an intermediate layer for inheritance. */
  readonly instantiable: boolean;
  /** Name of the direct parent preset. */
  readonly inherits?: string;
};

/** A flattened preset: the inheritance chain has been resolved and `inherits` is gone. */
export type ResolvedPreset = {
  readonly name: string;
  readonly kind: PresetKind;
  readonly origin: PresetOrigin;
  /** Inheritance chain from the leaf preset to the root; the first element is `name`. */
  readonly inheritanceChain: readonly string[];
  /** The complete flattened settings. */
  readonly settings: PresetRecord;
  /** Which layer of the inheritance chain each key actually came from, used to explain "where did this value come from". */
  readonly provenance: Readonly<Record<string, string>>;
};

/** Parameters the user asked to override. */
export type ParameterOverrides = Readonly<Record<string, PresetValue>>;

/** A single slicing request. */
export type SliceRequest = {
  /** Absolute path of the model file to slice (.stl / .3mf / .obj / .step). */
  readonly modelPath: string;
  readonly machinePreset: string;
  readonly processPreset: string;
  readonly filamentPresets: readonly string[];
  readonly overrides: ParameterOverrides;
  /** Geometric placement, mapped directly to CLI flags. */
  readonly placement?: SlicePlacement;
  /** Plate number to slice; 0 means all plates. */
  readonly plate?: number;
};

export type SlicePlacement = {
  readonly arrange?: boolean;
  readonly orient?: boolean;
  readonly ensureOnBed?: boolean;
  readonly scale?: number;
  readonly rotate?: number;
  readonly rotateX?: number;
  readonly rotateY?: number;
};

/** Objective statistics read back from the slicing output, all taken from the G-code header, not estimated. */
export type SliceStats = {
  readonly layerCount: number;
  readonly maxZHeight: number;
  readonly layerHeight: number;
  /** Seconds. From `; model printing time`. */
  readonly modelPrintTimeSeconds?: number;
  readonly totalEstimatedTimeSeconds?: number;
  /** Total for the whole plate, including filament-change flushing and the prime tower. For multi-colour prints, the sum of all colours. */
  readonly filamentGrams?: number;
  /** Total for the whole plate; for multi-colour prints, the sum of all colours. */
  readonly filamentLengthMm?: number;
  readonly filamentCostCny?: number;
  /** Per-colour usage for multi-colour prints; not returned for single-colour prints. */
  readonly filamentBreakdown?: readonly FilamentUsage[];
};

export type FilamentUsage = {
  /** Filament slot number (1-based), taken from `; filament:` in the G-code header. */
  readonly filament?: number;
  readonly grams?: number;
  readonly lengthMm?: number;
};

export type SliceOutcome = {
  readonly ok: true;
  readonly outputPath: string;
  readonly stats: SliceStats;
  /** The complete settings slicing actually used, read back from the output 3MF; the only trustworthy after-the-fact truth. */
  readonly appliedSettings: PresetRecord;
  /** Whether this run's overrides actually reached the output; any override that was not honoured is listed here. */
  readonly overrideAudit: readonly OverrideAuditEntry[];
  readonly warnings: readonly string[];
};

export type OverrideAuditEntry = {
  readonly key: string;
  readonly requested: PresetValue;
  readonly applied: PresetValue | undefined;
  readonly honoured: boolean;
};

export type SliceFailure = {
  readonly ok: false;
  readonly reason: string;
  readonly stderrTail: readonly string[];
};

export type SliceResult = SliceOutcome | SliceFailure;

/** Summary of the model geometry. */
export type ModelInspection = {
  readonly triangleCount: number;
  readonly boundingBox: BoundingBox;
  readonly volumeMm3: number;
  readonly surfaceAreaMm2: number;
  /** True when every edge is shared by exactly two triangles. */
  readonly closed: boolean;
  readonly degenerateTriangles: number;
  readonly openEdges: number;
};

export type BoundingBox = {
  readonly min: Vec3;
  readonly max: Vec3;
  readonly size: Vec3;
};

export type Vec3 = { readonly x: number; readonly y: number; readonly z: number };

/** A single finding from the printability check. */
export type PrintabilityFinding = {
  readonly code: PrintabilityCode;
  readonly severity: 'blocker' | 'warning' | 'note';
  readonly summary: string;
  readonly detail: string;
  /** Parameter keys suggested for adjustment; an empty array means this is not something parameters can fix. */
  readonly relatedParameters: readonly string[];
};

export type PrintabilityCode =
  | 'exceeds-build-volume'
  | 'non-manifold'
  | 'degenerate-geometry'
  | 'steep-overhang'
  | 'thin-feature'
  | 'small-footprint'
  | 'tall-and-narrow'
  | 'large-flat-area'
  | 'floating-part';

export type PrintabilityReport = {
  readonly inspection: ModelInspection;
  readonly buildVolume: Vec3;
  readonly fitsBuildVolume: boolean;
  /** Share of triangle area that needs support (0–1). */
  readonly overhangAreaRatio: number;
  /** Bodies that do not reach the build plate; an empty array means every body stands on its own. */
  readonly floatingBodies: readonly {
    readonly name: string;
    readonly partNames: readonly string[];
    readonly liftMm: number;
    readonly nearestBody: string | undefined;
    readonly gapMm: number | undefined;
    readonly gapAt: Vec3 | undefined;
  }[];
  readonly findings: readonly PrintabilityFinding[];
};
