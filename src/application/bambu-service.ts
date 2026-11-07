import { basename, isAbsolute, relative, resolve as resolvePath } from 'node:path';

import type {
  ParameterOverrides,
  PresetIndexEntry,
  PresetKind,
  PresetRecord,
  PresetValue,
  PrintabilityReport,
  ResolvedPreset,
  Vec3,
  SlicePlacement,
  SliceResult,
} from '../domain/contracts.js';
import {
  describeParameter,
  listParameters,
  ownerOf,
  rangeWarning,
  type ParameterGroup,
  type ParameterSpec,
} from '../domain/parameters/catalog.js';
import { isKnownParameterKey } from '../domain/parameters/known-keys.js';
import {
  optimizePrintInPlace,
  type OptimizationChange,
} from '../domain/parameters/optimizer.js';
import {
  applicableConditional,
  CONCERN_LABELS,
  getGoal,
  listGoals,
  matchGoal,
  type ConditionalMove,
  type GoalConcern,
  type GoalMove,
} from '../domain/parameters/goals.js';
import {
  explainRemedy,
  getSymptom,
  listSymptoms,
  matchSymptoms,
  type Symptom,
} from '../domain/parameters/diagnostics.js';
import { analysePrintability, DEFAULT_PRINTABILITY_OPTIONS } from '../domain/model/printability.js';
import { buildPrimitive, meshBounds, type PrimitiveShape } from '../domain/model/primitives.js';
import { inspectModel, parseStl } from '../domain/model/stl.js';
import { loadMesh, type MeshFileFormat } from '../domain/model/mesh-file.js';
import {
  analyseClearance,
  DEFAULT_CLEARANCE_OPTIONS,
  DEFAULT_MIN_DISTANCE_OPTIONS,
  type ClearanceReport,
} from '../domain/model/clearance.js';
import {
  buildBambuProject,
  isPartSubtype,
  readProjectStructure,
  trianglesToIndexedMesh,
  type ModelPart,
  type PartSubtype,
  type ProjectObject,
} from '../domain/model/threemf.js';
import { readZipEntry } from '../domain/slicing/zip.js';
import { diffPresets, type PresetDiffEntry } from '../domain/presets/resolver.js';
import type { ModelCatalog, ModelSearchResult } from '../ports/model-catalog.js';
import type { PresetStore, WriteUserPresetResult } from '../ports/preset-store.js';
import type { Slicer } from '../ports/slicer.js';

export type ModelFileReader = (path: string) => Buffer;

export type BambuServiceDependencies = {
  readonly presets: PresetStore;
  readonly slicer: Slicer;
  readonly catalogs: readonly ModelCatalog[];
  readonly readModelFile: ModelFileReader;
  /** Writes into the output directory and returns the full path. Undefined when no output directory is configured. */
  readonly writeOutputFile?: (fileName: string, data: Buffer) => string;
  /**
   * Root directories that model files may be read from.
   *
   * Principle: never expose arbitrary file paths to the MCP client.
   * An empty array means nothing is configured, and every file-reading tool refuses.
   */
  readonly allowedModelRoots: readonly string[];
  readonly version: string;
  readonly currentSelection: {
    readonly machine?: string;
    readonly process?: string;
    readonly filaments?: readonly string[];
  };
};

export type ServiceStatus = {
  readonly version: string;
  readonly dataDir: string;
  readonly profileId: string | undefined;
  readonly slicerPath: string;
  readonly slicerAvailable: boolean;
  readonly presetCounts: Readonly<Record<PresetKind, number>>;
  readonly currentSelection: BambuServiceDependencies['currentSelection'];
  readonly allowedModelRoots: readonly string[];
  readonly outputConfigured: boolean;
  readonly catalogs: readonly { readonly source: string; readonly integration: string; readonly ready: boolean }[];
  /** This server always flattens the preset inheritance chain before slicing. */
  readonly inheritanceFlattening: true;
};

export class PathNotAllowedError extends Error {
  constructor(path: string, roots: readonly string[]) {
    super(
      roots.length === 0
        ? `BAMBU_MODEL_DIR is not set; refusing to read ${path}. Set the allowed model directories in the server launch configuration.`
        : `${path} is not inside an allowed model directory: ${roots.join(', ')}`,
    );
    this.name = 'PathNotAllowedError';
  }
}

export class BambuService {
  readonly #deps: BambuServiceDependencies;

  constructor(dependencies: BambuServiceDependencies) {
    this.#deps = dependencies;
  }

  status(): ServiceStatus {
    const { presets, slicer, catalogs } = this.#deps;
    return {
      version: this.#deps.version,
      dataDir: presets.dataDir,
      profileId: presets.profileId,
      slicerPath: slicer.executablePath,
      slicerAvailable: slicer.available(),
      // Count only presets that can actually be selected. The system index contains many
      // fdm_* intermediate layers that exist purely to be inherited from; counting them
      // would distort the "how many presets can you use" number.
      presetCounts: {
        machine: countSelectable(presets.list('machine')),
        process: countSelectable(presets.list('process')),
        filament: countSelectable(presets.list('filament')),
      },
      currentSelection: this.#deps.currentSelection,
      allowedModelRoots: this.#deps.allowedModelRoots,
      outputConfigured: 'outputDir' in slicer && (slicer as { outputDir?: string }).outputDir !== undefined,
      catalogs: catalogs.map((catalog) => ({
        source: catalog.source,
        integration: catalog.integration,
        ready: catalog.ready(),
      })),
      inheritanceFlattening: true,
    };
  }

  // ── preset ─────────────────────────────────────────────────────────────

  listPresets(
    kind: PresetKind,
    options: { readonly search?: string; readonly instantiableOnly?: boolean; readonly limit?: number } = {},
  ): { readonly total: number; readonly entries: readonly PresetIndexEntry[] } {
    let entries = this.#deps.presets.list(kind);

    if (options.instantiableOnly !== false) {
      entries = entries.filter((entry) => entry.instantiable);
    }
    if (options.search !== undefined && options.search.trim() !== '') {
      const needle = options.search.trim().toLowerCase();
      entries = entries.filter((entry) => entry.name.toLowerCase().includes(needle));
    }

    const total = entries.length;
    const limit = options.limit ?? 50;
    return { total, entries: entries.slice(0, limit) };
  }

  /**
   * Flattens a preset and reports which layer each value came from.
   *
   * `keys` narrows the result to the parameters you care about; without it everything is
   * returned (a process preset has about 200 keys, and dumping them all on the model is
   * rarely useful, so the tool layer limits this by default).
   */
  resolvePreset(name: string, kind: PresetKind, keys?: readonly string[]): ResolvedPreset {
    const resolved = this.#deps.presets.resolve(name, kind);
    if (keys === undefined || keys.length === 0) return resolved;

    const settings: Record<string, PresetValue> = {};
    const provenance: Record<string, string> = {};
    for (const key of keys) {
      const value = resolved.settings[key];
      if (value === undefined) continue;
      settings[key] = value;
      const source = resolved.provenance[key];
      if (source !== undefined) provenance[key] = source;
    }
    return { ...resolved, settings, provenance };
  }

  comparePresets(
    left: string,
    right: string,
    kind: PresetKind,
  ): { readonly left: string; readonly right: string; readonly differences: readonly PresetDiffEntry[] } {
    const a = this.#deps.presets.resolve(left, kind);
    const b = this.#deps.presets.resolve(right, kind);
    return { left, right, differences: diffPresets(a.settings, b.settings) };
  }

  saveUserPreset(request: {
    readonly name: string;
    readonly kind: PresetKind;
    readonly inherits: string;
    readonly overrides: ParameterOverrides;
    readonly overwrite?: boolean;
  }): { readonly result: WriteUserPresetResult; readonly warnings: readonly string[] } {
    const warnings: string[] = [];

    // Check against the parent: overriding a key the parent does not have usually means a
    // misspelled name or the wrong preset kind. BambuStudio silently ignores keys it does not
    // recognise, so the user would believe the change was made when it was not; say so up front.
    const parent = this.#deps.presets.resolve(request.inherits, request.kind);
    for (const [key, value] of Object.entries(request.overrides)) {
      if (!(key in parent.settings)) {
        if (!isKnownParameterKey(key)) {
          warnings.push(`${key} is not a BambuStudio parameter name; check the spelling. Bambu Studio silently ignores it.`);
        } else {
          const owner = ownerOf(key);
          warnings.push(owner === request.kind
            ? `${key} is a valid ${request.kind} parameter, but the parent preset does not declare it; check the sliced output to confirm it is honoured.`
            : `${key} is a valid parameter but does not belong to a ${request.kind} preset` +
                (owner === undefined ? '' : ` (it belongs in a ${owner} preset)`) +
                '; it will be ignored here.');
        }
        continue;
      }
      if (typeof value === 'string') {
        const warning = rangeWarning(key, value);
        if (warning !== undefined) warnings.push(warning);
      }
    }

    return { result: this.#deps.presets.writeUserPreset(request), warnings };
  }

  /**
   * Creates a conservative print-in-place user process preset.
   *
   * It can start from a system preset or an existing user preset. Starting from a user preset
   * keeps the dimensional corrections already declared in its leaf, but the output still
   * inherits directly from the system preset, so layers of user inheritance do not pile up.
   */
  optimizePrintInPlacePreset(request: OptimizePrintInPlaceRequest): OptimizePrintInPlaceResult {
    const sourcePreset = request.processPreset ?? this.#deps.currentSelection.process;
    if (sourcePreset === undefined) {
      throw new Error('No current process preset found; select one in Bambu Studio first, or pass processPreset explicitly.');
    }

    const sourceRaw = this.#deps.presets.readRaw(sourcePreset, 'process');
    if (sourceRaw === undefined) {
      throw new Error(`Process preset not found: ${sourcePreset}`);
    }

    let basePreset = sourcePreset;
    let preserved: ParameterOverrides = {};
    if (sourceRaw.origin === 'user') {
      const parentName = sourceRaw.body['inherits'];
      if (typeof parentName !== 'string' || parentName.trim() === '') {
        throw new Error(`User preset "${sourcePreset}" has no recognisable system preset in inherits.`);
      }
      const parentRaw = this.#deps.presets.readRaw(parentName, 'process');
      if (parentRaw?.origin !== 'system') {
        throw new Error(
          `User preset "${sourcePreset}" does not inherit directly from a system preset; ` +
            'multiple layers of user inheritance are not expanded automatically, to avoid overwriting adjustments of unknown origin.',
        );
      }
      basePreset = parentName;
      preserved = extractDeclaredOverrides(sourceRaw.body, this.#deps.presets.resolve(basePreset, 'process').settings);
    }

    const effective = this.#deps.presets.resolve(sourcePreset, 'process').settings;
    const optimized = optimizePrintInPlace(effective, preserved, {
      ...(request.includeBrimEars === undefined ? {} : { includeBrimEars: request.includeBrimEars }),
    });
    const name = request.name?.trim() || `${sourcePreset} auto-stable`;
    const saved = this.saveUserPreset({
      name,
      kind: 'process',
      inherits: basePreset,
      overrides: optimized.overrides,
      ...(request.overwrite === undefined ? {} : { overwrite: request.overwrite }),
    });

    return {
      name,
      sourcePreset,
      basePreset,
      result: saved.result,
      overrides: optimized.overrides,
      changes: optimized.changes,
      preservedKeys: Object.keys(preserved).sort(),
      warnings: saved.warnings,
      manualActions: optimized.manualActions,
    };
  }

  // ── parameter knowledge ───────────────────────────────────────────────────────────

  describeParameters(options: {
    readonly keys?: readonly string[];
    readonly group?: ParameterGroup;
  }): { readonly specs: readonly ParameterSpec[]; readonly unknown: readonly string[] } {
    if (options.keys !== undefined && options.keys.length > 0) {
      const specs: ParameterSpec[] = [];
      const missing: string[] = [];
      for (const key of options.keys) {
        const spec = describeParameter(key);
        if (spec === undefined) missing.push(key);
        else specs.push(spec);
      }
      return { specs, unknown: missing };
    }
    return { specs: listParameters(options.group), unknown: [] };
  }

  diagnose(options: { readonly symptom?: string; readonly symptomId?: string; readonly material?: string }): {
    readonly matched: readonly ReturnType<typeof formatSymptom>[];
    readonly available: readonly { readonly id: string; readonly label: string }[];
    readonly note: string | undefined;
  } {
    const available = listSymptoms().map((symptom) => ({ id: symptom.id, label: symptom.label }));

    if (options.symptomId !== undefined) {
      const symptom = getSymptom(options.symptomId);
      return symptom === undefined
        ? { matched: [], available, note: `Unknown symptom id: ${options.symptomId}` }
        : { matched: [formatSymptom(symptom, options.material)], available, note: undefined };
    }

    if (options.symptom === undefined || options.symptom.trim() === '') {
      return { matched: [], available, note: 'Describe the symptom, or pass a symptomId directly.' };
    }

    const matches = matchSymptoms(options.symptom);
    if (matches.length === 0) {
      return {
        matched: [],
        available,
        note:
          'No known symptom matched. Fuzzy guessing is deliberately not done: a wrong guess gives advice that makes things worse. ' +
          'Pick a symptomId from available, or describe it in different words.',
      };
    }

    return {
      matched: matches.slice(0, 3).map((match) => formatSymptom(match.symptom, options.material)),
      available,
      note: undefined,
    };
  }

  // ── slicing ───────────────────────────────────────────────────────────────

  async slice(request: {
    readonly modelPath: string;
    readonly machinePreset?: string;
    readonly processPreset?: string;
    readonly filamentPresets?: readonly string[];
    readonly overrides?: ParameterOverrides;
    readonly placement?: SlicePlacement;
    readonly plate?: number;
  }): Promise<SliceResult> {
    const modelPath = this.#assertAllowed(request.modelPath);
    const selection = this.#deps.currentSelection;

    const machinePreset = request.machinePreset ?? selection.machine;
    const processPreset = request.processPreset ?? selection.process;
    const filamentPresets = request.filamentPresets ?? selection.filaments?.slice(0, 1) ?? [];

    if (machinePreset === undefined || processPreset === undefined || filamentPresets.length === 0) {
      return {
        ok: false,
        reason:
          'Missing presets. Specify machinePreset / processPreset / filamentPresets, ' +
          'or select a printer and filament in Bambu Studio first so this server can read them as defaults.',
        stderrTail: [],
      };
    }

    return this.#deps.slicer.slice({
      modelPath,
      machinePreset,
      processPreset,
      filamentPresets,
      overrides: request.overrides ?? {},
      ...(request.placement === undefined ? {} : { placement: request.placement }),
      ...(request.plate === undefined ? {} : { plate: request.plate }),
    });
  }

  // ── models ───────────────────────────────────────────────────────────────

  /**
   * Geometry measurements. Accepts STL, 3MF and OBJ; the format is detected from the
   * content, not the file extension.
   *
   * 3MF also returns the part count and part list: treating the combined volume of a
   * multi-part 3MF as a single solid is misleading, and what the user usually wants to know
   * is how many pieces are in there.
   */
  inspect(modelPath: string): ReturnType<typeof inspectModel> & {
    readonly format: MeshFileFormat;
    readonly partCount: number;
    readonly parts: readonly { readonly name: string; readonly triangleCount: number }[];
  } {
    const path = this.#assertAllowed(modelPath);
    const mesh = loadMesh(this.#deps.readModelFile(path), basename(path));
    const combined = inspectModel(mesh.triangles);

    // Closedness must be computed per part, not over all triangles pooled together.
    //
    // Multi-part 3MFs often have mating faces: two parts each have a triangle on the same
    // plane with exactly coincident edges. Counted together, such an edge is shared by four
    // triangles, and the "exactly two" rule reports it as a hole. On a planetary-gear fidget
    // spinner this produced 3675 false open edges, even though every part is closed.
    const perPart = mesh.parts.map((part) => inspectModel(part.triangles));
    const openEdges = perPart.reduce((sum, part) => sum + part.openEdges, 0);

    return {
      ...combined,
      closed: perPart.every((part) => part.closed),
      openEdges,
      degenerateTriangles: perPart.reduce((sum, part) => sum + part.degenerateTriangles, 0),
      format: mesh.format,
      partCount: mesh.parts.length,
      parts: mesh.parts.map((part) => ({ name: part.name, triangleCount: part.triangles.length })),
    };
  }

  /**
   * Clearance between parts. This is what decides whether a print-in-place model can move.
   *
   * Only 3MF and OBJ carry multi-part information; STL is a single triangle soup with no part
   * boundaries, so this says plainly that it cannot measure, rather than returning an empty
   * report that looks like an answer.
   */
  measureClearance(
    modelPath: string,
    options: {
      readonly minimumClearanceMm?: number;
      readonly reportThresholdMm?: number;
      readonly samplingMm?: number;
    } = {},
  ): ClearanceReport {
    const path = this.#assertAllowed(modelPath);
    const mesh = loadMesh(this.#deps.readModelFile(path), basename(path));

    if (mesh.format === 'stl') {
      throw new Error(
        'STL has no part boundaries, so clearance between parts cannot be measured: the whole file is one ungrouped pile of triangles. ' +
          'Use 3MF instead (a Bambu project or multi-part 3MF; MakerWorld downloads and Bambu Studio exports are both this) or OBJ (Tinkercad colour export).',
      );
    }

    return analyseClearance(
      mesh.parts,
      mesh.format,
      {
        minimumClearanceMm: options.minimumClearanceMm ?? DEFAULT_CLEARANCE_OPTIONS.minimumClearanceMm,
        reportThresholdMm: options.reportThresholdMm ?? DEFAULT_CLEARANCE_OPTIONS.reportThresholdMm,
        fuseEpsilonMm: DEFAULT_CLEARANCE_OPTIONS.fuseEpsilonMm,
      },
      {
        samplingMm: options.samplingMm ?? DEFAULT_MIN_DISTANCE_OPTIONS.samplingMm,
        maxSamples: DEFAULT_MIN_DISTANCE_OPTIONS.maxSamples,
      },
    );
  }

  checkPrintability(
    modelPath: string,
    options: {
      readonly buildVolume?: { readonly x: number; readonly y: number; readonly z: number };
      readonly overhangThresholdDegrees?: number;
      readonly lineWidthMm?: number;
    } = {},
  ): PrintabilityReport {
    const path = this.#assertAllowed(modelPath);
    const mesh = loadMesh(this.#deps.readModelFile(path), basename(path));
    return analysePrintability(
      mesh.triangles,
      {
        buildVolume: options.buildVolume ?? DEFAULT_PRINTABILITY_OPTIONS.buildVolume,
        overhangThresholdDegrees:
          options.overhangThresholdDegrees ?? DEFAULT_PRINTABILITY_OPTIONS.overhangThresholdDegrees,
        lineWidthMm: options.lineWidthMm ?? DEFAULT_PRINTABILITY_OPTIONS.lineWidthMm,
      },
      mesh.parts,
    );
  }

  // ── goal-driven planning ───────────────────────────────────────────────────────

  /**
   * Lays out a set of parameter adjustments for a goal, and when a model is given, adds
   * conditional adjustments based on its geometry.
   *
   * Each parameter's current value and its shape are reported alongside. The shape matters:
   * many parameters are per-nozzle arrays in the preset (e.g. `filament_z_hop` is
   * `["nil","0.6"]`, where `"nil"` is a literal meaning "not set"), and overriding a
   * multi-nozzle parameter with a scalar does nothing. Putting the current state next to the
   * suggestion keeps you from making a change that has no effect.
   */
  planSettings(request: PlanRequest): PlanResult {
    const goal =
      request.goalId !== undefined
        ? getGoal(request.goalId)
        : request.goal === undefined
          ? undefined
          : matchGoal(request.goal);

    const available = listGoals().map((entry) => ({ id: entry.id, label: entry.label }));

    if (goal === undefined) {
      return {
        goal: undefined,
        available,
        moves: [],
        printability: undefined,
        note:
          request.goal === undefined && request.goalId === undefined
            ? 'Say what you want (e.g. "don\'t fail, print slowly" or "in a hurry"), or pass a goalId directly.'
            : 'No known goal matched. Guessing is deliberately not done: a wrong goal pushes the whole set of parameters the wrong way. Pick one from available.',
      };
    }

    // If there is a model, look at its geometry first; it triggers the conditional adjustments.
    let printability: PrintabilityReport | undefined;
    if (request.modelPath !== undefined) {
      printability = this.checkPrintability(request.modelPath);
    }

    const triggered = applicableConditional(
      goal,
      printability?.findings.map((finding) => finding.code) ?? [],
    );

    const resolved = this.#resolveForLookup(request);

    // Map the two lists separately so a union does not erase the fields specific to ConditionalMove.
    const describe = (move: GoalMove, trigger?: ConditionalMove): PlannedMove => {
      const current = lookupCurrent(move.key, resolved);
      const spec = describeParameter(move.key);
      return {
        key: move.key,
        concern: move.concern,
        concernLabel: CONCERN_LABELS[move.concern],
        direction: move.direction,
        suggested: move.suggested,
        rationale: move.rationale,
        cost: move.cost,
        parameterLabel: spec?.label,
        unit: spec?.unit,
        currentValue: current.value,
        valueShape: current.shape,
        ownedBy: current.owner,
        triggeredBy: trigger?.when,
        triggerReason: trigger?.because,
      };
    };

    const moves: readonly PlannedMove[] = [
      ...goal.moves.map((move) => describe(move)),
      ...triggered.map((move) => describe(move, move)),
    ];

    const materialKey = request.material?.trim().toUpperCase();
    const materialNote =
      materialKey === undefined || goal.materialNotes === undefined
        ? undefined
        : goal.materialNotes[materialKey];

    return {
      goal: {
        id: goal.id,
        label: goal.label,
        optimisesFor: goal.optimisesFor,
        tradesAway: goal.tradesAway,
        materialNote,
        notAParameterProblem: goal.notAParameterProblem,
      },
      available,
      moves,
      printability,
      note: undefined,
    };
  }

  /** Resolves only the presets the caller named; falls back to Studio's current selection, and skips current-value lookup when neither exists. */
  #resolveForLookup(request: PlanRequest): Partial<Record<PresetKind, PresetRecord>> {
    const out: Partial<Record<PresetKind, PresetRecord>> = {};
    const processName = request.processPreset ?? this.#deps.currentSelection.process;
    const filamentName = request.filamentPreset ?? this.#deps.currentSelection.filaments?.[0];

    for (const [kind, name] of [
      ['process', processName],
      ['filament', filamentName],
    ] as const) {
      if (name === undefined) continue;
      try {
        out[kind] = this.#deps.presets.resolve(name, kind).settings;
      } catch {
        // A missing preset name must not fail the whole plan; leave the current values empty.
      }
    }
    return out;
  }

  // ── 3MF composition ───────────────────────────────────────────────────────────

  /**
   * Builds a Bambu project 3MF from a body plus additional parts.
   *
   * This is a non-destructive edit: in Bambu's model, negative volumes, modifier regions and
   * support enforcers/blockers are each just one more part with a subtype tag, so no geometry
   * (CSG) engine is needed and the GUI does not have to be driven.
   */
  composeModel(request: ComposeRequest): ComposeResult {
    const write = this.#deps.writeOutputFile;
    if (write === undefined) {
      throw new Error('BAMBU_OUTPUT_DIR is not set; refusing to write to a directory that was not authorised.');
    }

    const warnings: string[] = [];
    const basePath = this.#assertAllowed(request.basePath);
    const baseTriangles = parseStl(this.#deps.readModelFile(basePath));
    const baseMesh = trianglesToIndexedMesh(baseTriangles);
    const baseBounds = meshBounds(baseMesh);

    const parts: ModelPart[] = [
      { name: request.baseName ?? 'body', subtype: 'normal_part', mesh: baseMesh },
    ];
    const summaries: PartSummary[] = [
      {
        name: parts[0]?.name ?? 'body',
        subtype: 'normal_part',
        triangleCount: baseMesh.triangles.length,
        bounds: baseBounds,
        intersectsBody: true,
      },
    ];

    for (const spec of request.parts) {
      if (!isPartSubtype(spec.subtype)) {
        throw new Error(
          `Invalid part subtype: ${spec.subtype}. ` +
            'BambuStudio silently falls back to normal_part for strings it does not recognise: ' +
            '"cut a piece away" turns into "add a solid piece", with no error message at all.',
        );
      }

      const mesh =
        spec.shape.kind === 'stl'
          ? trianglesToIndexedMesh(parseStl(this.#deps.readModelFile(this.#assertAllowed(spec.shape.path))))
          : buildPrimitive(spec.shape, spec.position ?? { x: 0, y: 0, z: 0 });

      const bounds = meshBounds(mesh);
      const intersects = boundsOverlap(baseBounds, bounds);

      if (!intersects) {
        warnings.push(
          `Part "${spec.name}" does not intersect the body and will have no effect. ` +
            `Body bounds ${fmtBounds(baseBounds)}, this part ${fmtBounds(bounds)}.`,
        );
      }

      for (const key of Object.keys(spec.settings ?? {})) {
        if (!isKnownParameterKey(key)) {
          warnings.push(`Setting ${key} on part "${spec.name}" is not a BambuStudio parameter name and will be ignored.`);
        }
      }
      if (spec.settings !== undefined && spec.subtype !== 'modifier_part') {
        warnings.push(
          `Part "${spec.name}" carries settings but its subtype is ${spec.subtype}; ` +
            'part-level settings are honoured only on modifier_part.',
        );
      }

      parts.push({
        name: spec.name,
        subtype: spec.subtype,
        mesh,
        ...(spec.settings === undefined ? {} : { settings: spec.settings }),
      });
      summaries.push({
        name: spec.name,
        subtype: spec.subtype,
        triangleCount: mesh.triangles.length,
        bounds,
        intersectsBody: intersects,
      });
    }

    const buffer = buildBambuProject({
      objectName: request.name,
      parts,
      ...(request.plateCentre === undefined ? {} : { plateCentre: request.plateCentre }),
    });

    const fileName = request.name.endsWith('.3mf') ? request.name : `${request.name}.3mf`;
    const outputPath = write(fileName, buffer);

    return { outputPath, parts: summaries, warnings, byteLength: buffer.length };
  }

  /** Reads back the object and part structure of a 3MF, to confirm that what was written is really in there. */
  inspectProject(projectPath: string): readonly ProjectObject[] {
    const path = this.#assertAllowed(projectPath);
    const entry = readZipEntry(this.#deps.readModelFile(path), 'Metadata/model_settings.config');
    if (entry === undefined) {
      throw new Error(`${projectPath} has no Metadata/model_settings.config; it is not a Bambu project 3MF.`);
    }
    return readProjectStructure(entry.toString('utf8'));
  }

  // ── search ───────────────────────────────────────────────────────────────

  async searchModels(
    query: string,
    sources: readonly string[] | undefined,
    limit: number,
  ): Promise<readonly ModelSearchResult[]> {
    const selected =
      sources === undefined || sources.length === 0
        ? this.#deps.catalogs
        : this.#deps.catalogs.filter((catalog) => sources.includes(catalog.source));

    return Promise.all(selected.map((catalog) => catalog.search(query, limit)));
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /**
   * The file path must fall inside an allowed root directory.
   *
   * Uses `relative()` rather than a string prefix comparison: the latter would let
   * `/models-evil` pass the check for `/models`. `..` is also resolved to prevent path traversal.
   */
  #assertAllowed(candidate: string): string {
    const roots = this.#deps.allowedModelRoots;
    const absolute = isAbsolute(candidate) ? resolvePath(candidate) : resolvePath(candidate);

    for (const root of roots) {
      const rel = relative(resolvePath(root), absolute);
      if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
        return absolute;
      }
    }
    throw new PathNotAllowedError(candidate, roots);
  }
}

export type PlanRequest = {
  readonly goal?: string;
  readonly goalId?: string;
  readonly processPreset?: string;
  readonly filamentPreset?: string;
  readonly modelPath?: string;
  readonly material?: string;
};

export type PlannedMove = {
  readonly key: string;
  readonly concern: GoalConcern;
  readonly concernLabel: string;
  readonly direction: string;
  readonly suggested: string | undefined;
  readonly rationale: string;
  readonly cost: string;
  readonly parameterLabel: string | undefined;
  readonly unit: string | undefined;
  readonly currentValue: PresetValue | undefined;
  readonly valueShape: 'scalar' | 'per-extruder' | 'unknown';
  readonly ownedBy: PresetKind | undefined;
  readonly triggeredBy: string | undefined;
  readonly triggerReason: string | undefined;
};

export type PlanResult = {
  readonly goal:
    | {
        readonly id: string;
        readonly label: string;
        readonly optimisesFor: string;
        readonly tradesAway: string;
        readonly materialNote: string | undefined;
        readonly notAParameterProblem: string | undefined;
      }
    | undefined;
  readonly available: readonly { readonly id: string; readonly label: string }[];
  readonly moves: readonly PlannedMove[];
  readonly printability: PrintabilityReport | undefined;
  readonly note: string | undefined;
};

export type OptimizePrintInPlaceRequest = {
  readonly name?: string;
  readonly processPreset?: string;
  readonly includeBrimEars?: boolean;
  readonly overwrite?: boolean;
};

export type OptimizePrintInPlaceResult = {
  readonly name: string;
  readonly sourcePreset: string;
  readonly basePreset: string;
  readonly result: WriteUserPresetResult;
  readonly overrides: ParameterOverrides;
  readonly changes: readonly OptimizationChange[];
  readonly preservedKeys: readonly string[];
  readonly warnings: readonly string[];
  readonly manualActions: readonly string[];
};

/** Keeps only the genuine process overrides from a user preset's leaf, without carrying metadata into the new file. */
function extractDeclaredOverrides(
  body: Readonly<Record<string, unknown>>,
  parent: PresetRecord,
): ParameterOverrides {
  const overrides: Record<string, PresetValue> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!(key in parent) && ownerOf(key) !== 'process') continue;
    if (typeof value === 'string') {
      overrides[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.every((item): item is string => typeof item === 'string')) {
      overrides[key] = value;
    }
  }
  return overrides;
}

/**
 * Looks up a parameter's current value and shape.
 *
 * The shape decides how the override must be written: a `per-extruder` parameter needs an
 * array, and a scalar does nothing. Returns `unknown` when neither preset has it; that does
 * not guarantee the key does not exist, only that these two presets do not declare it.
 */
function lookupCurrent(
  key: string,
  resolved: Partial<Record<PresetKind, PresetRecord>>,
): {
  readonly value: PresetValue | undefined;
  readonly shape: 'scalar' | 'per-extruder' | 'unknown';
  readonly owner: PresetKind | undefined;
} {
  for (const kind of ['process', 'filament', 'machine'] as const) {
    const value = resolved[kind]?.[key];
    if (value === undefined) continue;
    return {
      value,
      shape: Array.isArray(value) ? 'per-extruder' : 'scalar',
      owner: kind,
    };
  }
  return { value: undefined, shape: 'unknown', owner: ownerOf(key) };
}

export type ComposePartSpec = {
  readonly name: string;
  readonly subtype: PartSubtype;
  readonly shape: PrimitiveShape | { readonly kind: 'stl'; readonly path: string };
  readonly position?: Vec3;
  readonly settings?: Readonly<Record<string, PresetValue>>;
};

export type ComposeRequest = {
  readonly name: string;
  readonly basePath: string;
  readonly baseName?: string;
  readonly parts: readonly ComposePartSpec[];
  readonly plateCentre?: { readonly x: number; readonly y: number };
};

export type Bounds = { readonly min: Vec3; readonly max: Vec3 };

export type PartSummary = {
  readonly name: string;
  readonly subtype: PartSubtype;
  readonly triangleCount: number;
  readonly bounds: Bounds;
  readonly intersectsBody: boolean;
};

export type ComposeResult = {
  readonly outputPath: string;
  readonly parts: readonly PartSummary[];
  readonly warnings: readonly string[];
  readonly byteLength: number;
};

/**
 * Whether two bounding boxes intersect.
 *
 * Catches mistakes like a negative volume placed where it never touches the body. That
 * produces a valid but completely ineffective 3MF: after slicing nothing has changed and
 * nobody knows why. Intersecting bounding boxes do not mean the solids intersect, so this
 * only warns and never blocks.
 */
function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return (
    a.min.x < b.max.x && a.max.x > b.min.x &&
    a.min.y < b.max.y && a.max.y > b.min.y &&
    a.min.z < b.max.z && a.max.z > b.min.z
  );
}

function fmtBounds(b: Bounds): string {
  return `(${b.min.x.toFixed(1)}, ${b.min.y.toFixed(1)}, ${b.min.z.toFixed(1)}) – (${b.max.x.toFixed(1)}, ${b.max.y.toFixed(1)}, ${b.max.z.toFixed(1)})`;
}

function countSelectable(entries: readonly PresetIndexEntry[]): number {
  return entries.filter((entry) => entry.instantiable).length;
}

function formatSymptom(symptom: Symptom, material: string | undefined): {
  readonly id: string;
  readonly label: string;
  readonly mechanism: string;
  readonly remedies: readonly ReturnType<typeof explainRemedy>[];
  readonly materialNote: string | undefined;
  readonly notAParameterProblem: string | undefined;
} {
  const key = material?.trim().toUpperCase();
  const materialNote =
    key === undefined || symptom.materialNotes === undefined
      ? undefined
      : symptom.materialNotes[key];

  return {
    id: symptom.id,
    label: symptom.label,
    mechanism: symptom.mechanism,
    remedies: symptom.remedies.map(explainRemedy),
    materialNote,
    notAParameterProblem: symptom.notAParameterProblem,
  };
}

export type { PresetRecord };
