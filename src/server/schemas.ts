import { z } from 'zod';

/**
 * Input and output schemas for the tools.
 *
 * The MCP SDK's `registerTool` takes a ZodRawShape (an object of fields), not a `z.object(...)`.
 */

const presetKind = z.enum(['machine', 'process', 'filament']);

/** A preset value: a single value, or an array with one entry per extruder. */
const presetValue = z.union([z.string(), z.array(z.string())]);

const overrides = z
  .record(z.string(), presetValue)
  .describe('Parameters to override; each key is a BambuStudio setting name (e.g. layer_height, sparse_infill_density).');

export const getStatusInputSchema = {};

export const statusOutputSchema = {
  version: z.string(),
  dataDir: z.string(),
  profileId: z.string().optional(),
  slicerPath: z.string(),
  slicerAvailable: z.boolean(),
  presetCounts: z.object({
    machine: z.number(),
    process: z.number(),
    filament: z.number(),
  }),
  currentSelection: z.object({
    machine: z.string().optional(),
    process: z.string().optional(),
    filaments: z.array(z.string()).optional(),
  }),
  allowedModelRoots: z.array(z.string()),
  outputConfigured: z.boolean(),
  catalogs: z.array(
    z.object({ source: z.string(), integration: z.string(), ready: z.boolean() }),
  ),
  inheritanceFlattening: z.literal(true),
};

export const listPresetsInputSchema = {
  kind: presetKind,
  search: z.string().optional().describe('Filter by a case-insensitive substring of the preset name.'),
  includeAbstract: z
    .boolean()
    .optional()
    .describe('Whether to include intermediate presets that exist only to be inherited from and cannot be selected in the UI. Defaults to false.'),
  limit: z.number().int().min(1).max(200).optional(),
};

export const listPresetsOutputSchema = {
  kind: presetKind,
  total: z.number(),
  returned: z.number(),
  entries: z.array(
    z.object({
      name: z.string(),
      origin: z.enum(['system', 'user']),
      instantiable: z.boolean(),
      inherits: z.string().optional(),
      relativePath: z.string(),
    }),
  ),
};

export const resolvePresetInputSchema = {
  name: z.string(),
  kind: presetKind,
  keys: z
    .array(z.string())
    .optional()
    .describe('Return only these parameters. Omit to return all of them (a process preset has about 200 keys).'),
};

export const resolvePresetOutputSchema = {
  name: z.string(),
  kind: presetKind,
  origin: z.enum(['system', 'user']),
  inheritanceChain: z.array(z.string()).describe('The inheritance chain, from the leaf preset to the root.'),
  settingCount: z.number(),
  settings: z.record(z.string(), presetValue),
  provenance: z
    .record(z.string(), z.string())
    .describe(
      'Which level of the inheritance chain each key actually comes from. Machine G-code may come from that level\'s template entry, ' +
        'named like "<preset> template machine_start_gcode".',
    ),
};

export const comparePresetsInputSchema = {
  left: z.string(),
  right: z.string(),
  kind: presetKind,
  limit: z.number().int().min(1).max(500).optional(),
};

export const comparePresetsOutputSchema = {
  left: z.string(),
  right: z.string(),
  differenceCount: z.number(),
  differences: z.array(
    z.object({
      key: z.string(),
      left: presetValue.optional(),
      right: presetValue.optional(),
    }),
  ),
};

export const describeParametersInputSchema = {
  keys: z.array(z.string()).optional(),
  group: z
    .enum([
      'quality',
      'strength',
      'speed',
      'adhesion',
      'support',
      'temperature',
      'cooling',
      'retraction',
      'accuracy',
      'surface',
    ])
    .optional(),
};

export const describeParametersOutputSchema = {
  specs: z.array(
    z.object({
      key: z.string(),
      owner: presetKind,
      group: z.string(),
      label: z.string(),
      valueType: z.string(),
      unit: z.string().optional(),
      typicalRange: z.object({ min: z.number(), max: z.number() }).optional(),
      enumValues: z.array(z.string()).optional(),
      whatItDoes: z.string(),
      raising: z.string(),
      lowering: z.string(),
      related: z.array(z.string()),
    }),
  ),
  unknown: z.array(z.string()).describe('Keys that are not in the parameter catalog.'),
};

export const diagnoseInputSchema = {
  symptom: z.string().optional().describe('The symptom in natural language, e.g. "the bottom layer bulges outward" (elephant\'s foot). Chinese descriptions are matched too.'),
  symptomId: z.string().optional().describe('A known symptom id; skips text matching.'),
  material: z.string().optional().describe('The material, e.g. PLA / ABS / PETG / TPU; a material-specific note is returned when one exists.'),
};

export const diagnoseOutputSchema = {
  matched: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      mechanism: z.string(),
      remedies: z.array(
        z.object({
          key: z.string(),
          direction: z.string(),
          suggested: z.string().optional(),
          rationale: z.string(),
          cost: z.string(),
          parameterLabel: z.string().optional(),
          parameterUnit: z.string().optional(),
          typicalRange: z.object({ min: z.number(), max: z.number() }).optional(),
        }),
      ),
      materialNote: z.string().optional(),
      notAParameterProblem: z.string().optional(),
    }),
  ),
  available: z.array(z.object({ id: z.string(), label: z.string() })),
  note: z.string().optional(),
};

export const planSettingsInputSchema = {
  goal: z
    .string()
    .optional()
    .describe('What you want, in natural language, e.g. "don\'t let it fail, print slowly at high quality" or "in a hurry". Chinese goals are matched too.'),
  goalId: z
    .enum(['safe', 'fast', 'strong', 'surface', 'economical'])
    .optional()
    .describe('Specify the goal directly; skips text matching.'),
  modelPath: z
    .string()
    .optional()
    .describe('If a model is given, a printability analysis runs first and conditional adjustments are added based on the geometry (e.g. a wider brim when the base area is too small).'),
  processPreset: z.string().optional().describe('Defaults to the preset currently selected in Bambu Studio.'),
  filamentPreset: z.string().optional(),
  material: z.string().optional().describe('PLA / PETG / ABS / ASA / TPU; a material-specific note is returned when one exists.'),
};

export const planSettingsOutputSchema = {
  goal: z
    .object({
      id: z.string(),
      label: z.string(),
      optimisesFor: z.string(),
      tradesAway: z.string(),
      materialNote: z.string().optional(),
      notAParameterProblem: z.string().optional(),
    })
    .optional(),
  available: z.array(z.object({ id: z.string(), label: z.string() })),
  moves: z.array(
    z.object({
      key: z.string(),
      concern: z.string(),
      concernLabel: z.string(),
      direction: z.string(),
      suggested: z.string().optional(),
      rationale: z.string(),
      cost: z.string(),
      parameterLabel: z.string().optional(),
      unit: z.string().optional(),
      currentValue: presetValue.optional().describe('The value in the current preset.'),
      valueShape: z
        .enum(['scalar', 'per-extruder', 'unknown'])
        .describe('Per-extruder parameters must be overridden with an array; a scalar is silently not applied.'),
      ownedBy: z.string().optional(),
      triggeredBy: z.string().optional().describe('Which printability finding triggered this move; empty means it is a base adjustment for the goal.'),
      triggerReason: z.string().optional(),
    }),
  ),
  printability: z
    .object({
      fitsBuildVolume: z.boolean(),
      overhangAreaRatio: z.number(),
      findings: z.array(
        z.object({ code: z.string(), severity: z.string(), summary: z.string() }),
      ),
    })
    .optional(),
  note: z.string().optional(),
};

export const optimizePrintInPlaceInputSchema = {
  name: z
    .string()
    .optional()
    .describe('Name of the new user preset. Defaults to the source preset name with an auto-stabilised suffix appended.'),
  processPreset: z
    .string()
    .optional()
    .describe('The source process preset; defaults to the one currently selected in Bambu Studio. An existing user preset may be given.'),
  includeBrimEars: z
    .boolean()
    .optional()
    .describe('Whether to also enable 5 mm Brim Ears. Defaults to false, because the moving clearances must be checked in the first-layer preview first.'),
  overwrite: z.boolean().optional().describe('Whether to replace a preset with the same name if one already exists. Defaults to false.'),
};

export const optimizePrintInPlaceOutputSchema = {
  name: z.string(),
  sourcePreset: z.string(),
  basePreset: z.string(),
  path: z.string(),
  created: z.boolean(),
  overwritten: z.boolean(),
  overrides,
  changes: z.array(
    z.object({
      key: z.string(),
      before: presetValue.optional(),
      after: presetValue,
      rationale: z.string(),
    }),
  ),
  preservedKeys: z.array(z.string()),
  warnings: z.array(z.string()),
  manualActions: z.array(z.string()),
  nextStep: z.string(),
};

export const saveUserPresetInputSchema = {
  name: z.string().describe('Name of the new preset; it appears in the Bambu Studio dropdown.'),
  kind: presetKind,
  inherits: z.string().describe('Name of the system (vendor) preset to inherit from.'),
  overrides,
  overwrite: z.boolean().optional().describe('Whether to replace an existing preset with the same name. Defaults to false.'),
};

export const saveUserPresetOutputSchema = {
  path: z.string(),
  created: z.boolean(),
  overwritten: z.boolean(),
  warnings: z.array(z.string()),
  nextStep: z.string(),
};

export const sliceInputSchema = {
  modelPath: z.string().describe('Absolute path to the model file; it must be inside an allowed model directory.'),
  machinePreset: z.string().optional(),
  processPreset: z.string().optional(),
  filamentPresets: z.array(z.string()).optional(),
  overrides: overrides.optional(),
  placement: z
    .object({
      arrange: z.boolean().optional(),
      orient: z.boolean().optional(),
      ensureOnBed: z.boolean().optional(),
      scale: z.number().positive().optional(),
      rotate: z.number().optional(),
      rotateX: z.number().optional(),
      rotateY: z.number().optional(),
    })
    .optional(),
  plate: z.number().int().min(0).optional(),
  reportSettings: z
    .array(z.string())
    .optional()
    .describe(
      'Read back the values these parameters actually took in the output. Use it to confirm the slice really used the preset values ' +
        'rather than the slicer\'s built-in defaults.',
    ),
};

export const sliceOutputSchema = {
  ok: z.boolean(),
  outputPath: z.string().optional(),
  reason: z.string().optional(),
  stderrTail: z.array(z.string()).optional(),
  stats: z
    .object({
      layerCount: z.number(),
      maxZHeight: z.number(),
      layerHeight: z.number(),
      modelPrintTimeSeconds: z.number().optional(),
      totalEstimatedTimeSeconds: z.number().optional(),
      filamentGrams: z.number().optional().describe('Total for the whole plate (including filament-change flushing and the prime tower); for multi-colour prints, the sum of all colours.'),
      filamentLengthMm: z.number().optional().describe('Total for the whole plate; for multi-colour prints, the sum of all colours.'),
      filamentBreakdown: z
        .array(
          z.object({
            filament: z.number().optional().describe('Filament slot number (1-based).'),
            grams: z.number().optional(),
            lengthMm: z.number().optional(),
          }),
        )
        .optional()
        .describe('Usage per colour for multi-colour prints; omitted for single-colour prints.'),
    })
    .optional(),
  overrideAudit: z
    .array(
      z.object({
        key: z.string(),
        requested: presetValue,
        applied: presetValue.optional(),
        honoured: z.boolean(),
      }),
    )
    .optional(),
  appliedSettings: z
    .record(z.string(), presetValue)
    .optional()
    .describe('The actual values in the output of the parameters requested by reportSettings.'),
  warnings: z.array(z.string()).optional(),
};

export const inspectModelInputSchema = {
  modelPath: z.string(),
};

const boundingBox = z.object({
  min: z.object({ x: z.number(), y: z.number(), z: z.number() }),
  max: z.object({ x: z.number(), y: z.number(), z: z.number() }),
  size: z.object({ x: z.number(), y: z.number(), z: z.number() }),
});

export const inspectModelOutputSchema = {
  triangleCount: z.number(),
  boundingBox,
  volumeMm3: z.number(),
  surfaceAreaMm2: z.number(),
  closed: z.boolean(),
  degenerateTriangles: z.number(),
  openEdges: z.number(),
  format: z.enum(['stl', '3mf', 'obj']).optional().describe('The format actually detected, based on the content rather than the file extension.'),
  partCount: z.number().optional(),
  parts: z.array(z.object({ name: z.string(), triangleCount: z.number() })).optional(),
};

export const measureClearanceInputSchema = {
  modelPath: z.string().describe('Absolute path to a 3MF or OBJ file; it must be inside an allowed model directory.'),
  minimumClearanceMm: z
    .number()
    .positive()
    .optional()
    .describe('The smallest clearance that prints reliably. Defaults to 0.15 (the practical lower limit for PLA with a 0.4 mm nozzle).'),
  reportThresholdMm: z
    .number()
    .positive()
    .optional()
    .describe('Part pairs farther apart than this are left out of the report. Defaults to 2 mm.'),
  samplingMm: z
    .number()
    .positive()
    .optional()
    .describe('Surface sampling spacing; smaller is more accurate but slower. Defaults to 0.2 mm.'),
};

export const measureClearanceOutputSchema = {
  format: z.string(),
  partCount: z.number(),
  bodies: z.array(
    z.object({
      name: z.string(),
      partNames: z.array(z.string()),
      extruders: z.array(z.string()),
      triangleCount: z.number(),
      boundingBox,
    }),
  ),
  pairs: z.array(
    z.object({
      a: z.string(),
      b: z.string(),
      gapMm: z.number(),
      at: z.object({ x: z.number(), y: z.number(), z: z.number() }),
      verdict: z.enum(['will-fuse', 'marginal', 'adequate']),
      enclosure: z.enum(['a-encloses-b', 'b-encloses-a', 'neither']),
    }),
  ),
  tightestGapMm: z.number().optional(),
  minimumClearanceMm: z.number(),
  findings: z.array(z.string()),
  recommendation: z
    .object({
      xy_contour_compensation: z.string(),
      xy_hole_compensation: z.string(),
      rationale: z.string(),
    })
    .optional(),
};

export const checkPrintabilityInputSchema = {
  modelPath: z.string(),
  buildVolume: z
    .object({ x: z.number().positive(), y: z.number().positive(), z: z.number().positive() })
    .optional()
    .describe('Defaults to 256×256×256 mm (Bambu Lab P1S / X1C).'),
  overhangThresholdDegrees: z
    .number()
    .min(0)
    .max(90)
    .optional()
    .describe('Angle from vertical; 0° is a vertical wall, 90° is a horizontal ceiling. Defaults to 45.'),
  lineWidthMm: z.number().positive().optional(),
};

export const checkPrintabilityOutputSchema = {
  inspection: z.object({
    triangleCount: z.number(),
    boundingBox,
    volumeMm3: z.number(),
    surfaceAreaMm2: z.number(),
    closed: z.boolean(),
    degenerateTriangles: z.number(),
    openEdges: z.number(),
  }),
  buildVolume: z.object({ x: z.number(), y: z.number(), z: z.number() }),
  fitsBuildVolume: z.boolean(),
  overhangAreaRatio: z.number(),
  floatingBodies: z
    .array(
      z.object({
        name: z.string(),
        partNames: z.array(z.string()),
        liftMm: z.number().describe('Height of this body\'s lowest point above the plate.'),
        nearestBody: z.string().optional(),
        gapMm: z.number().optional().describe('Width of the gap to the nearest body (in the model\'s original dimensions).'),
        gapAt: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(),
      }),
    )
    .optional()
    .describe('Bodies that do not touch the plate. A gap within 2 mm usually means the parts were not joined during modelling and must be fixed in the modelling software; turning on support would make them print as separate pieces.'),
  findings: z.array(
    z.object({
      code: z.string(),
      severity: z.enum(['blocker', 'warning', 'note']),
      summary: z.string(),
      detail: z.string(),
      relatedParameters: z.array(z.string()),
    }),
  ),
};

const vec3 = z.object({ x: z.number(), y: z.number(), z: z.number() });

const shape = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('box'), size: vec3 }),
  z.object({
    kind: z.literal('cylinder'),
    diameter: z.number().positive(),
    height: z.number().positive(),
    segments: z.number().int().min(8).max(128).optional(),
  }),
  z.object({
    kind: z.literal('sphere'),
    diameter: z.number().positive(),
    segments: z.number().int().min(8).max(128).optional(),
  }),
  z.object({ kind: z.literal('stl'), path: z.string() }),
]);

export const composeModelInputSchema = {
  name: z.string().min(1).describe('Output file name (.3mf is appended automatically) and object name. Must not contain path separators.'),
  basePath: z.string().describe('Path to the base body STL; it must be inside an allowed model directory.'),
  baseName: z.string().optional().describe('Display name of the base body part. Defaults to body.'),
  parts: z
    .array(
      z.object({
        name: z.string().min(1),
        subtype: z
          .enum(['negative_part', 'modifier_part', 'support_blocker', 'support_enforcer', 'normal_part'])
          .describe(
            'negative_part cuts material away, modifier_part is a region with local settings, support_blocker / support_enforcer control support, ' +
              'normal_part adds a solid. BambuStudio silently treats any unrecognised string as normal_part, so only these five are accepted.',
          ),
        shape,
        position: vec3.optional().describe('Centre of the primitive shape, in the same coordinate system as the base body. Ignored for stl shapes.'),
        settings: z
          .record(z.string(), presetValue)
          .optional()
          .describe('Per-part settings; honoured only for modifier_part.'),
      }),
    )
    .min(1),
  plateCentre: z
    .object({ x: z.number(), y: z.number() })
    .optional()
    .describe('Where the object lands on the plate. Defaults to the centre of a 256×256 plate (128, 128).'),
};

export const composeModelOutputSchema = {
  outputPath: z.string(),
  byteLength: z.number(),
  parts: z.array(
    z.object({
      name: z.string(),
      subtype: z.string(),
      triangleCount: z.number(),
      bounds: z.object({ min: vec3, max: vec3 }),
      intersectsBody: z.boolean(),
    }),
  ),
  warnings: z.array(z.string()),
  nextStep: z.string(),
};

export const inspectProjectInputSchema = {
  projectPath: z.string().describe('Path to a Bambu project 3MF.'),
};

export const inspectProjectOutputSchema = {
  objects: z.array(
    z.object({
      id: z.string(),
      name: z.string().optional(),
      parts: z.array(
        z.object({
          id: z.string(),
          subtype: z.string(),
          recognised: z.boolean(),
          name: z.string().optional(),
          settings: z.record(z.string(), z.string()),
        }),
      ),
    }),
  ),
};

export const searchModelsInputSchema = {
  query: z.string().min(1),
  sources: z
    .array(z.string())
    .optional()
    .describe('Restrict to these platforms; omit to query all. See catalogs in bambu_get_status for the available values.'),
  limit: z.number().int().min(1).max(30).optional(),
};

export const searchModelsOutputSchema = {
  query: z.string(),
  results: z.array(
    z.object({
      source: z.string(),
      integration: z.enum(['official-api', 'handoff-only']),
      hits: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          url: z.string(),
          creator: z.string().optional(),
          license: z.string().optional(),
          thumbnailUrl: z.string().optional(),
          likes: z.number().optional(),
          downloads: z.number().optional(),
        }),
      ),
      handoffUrl: z.string().optional(),
      notes: z.array(z.string()),
    }),
  ),
};
