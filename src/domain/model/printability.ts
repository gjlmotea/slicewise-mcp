import type { PrintabilityFinding, PrintabilityReport, Vec3 } from '../contracts.js';
import { findFloatingBodies, type FloatingBody } from './floating.js';
import { boundingBox, faceNormal, inspectModel, triangleArea, type Triangle } from './stl.js';
import type { MeshPart } from './threemf-reader.js';

/**
 * 可列印性分析。
 *
 * 這裡做的是「切片前就看得出來的問題」，不是完整的切片模擬。
 * 每一項檢查都標明它的判準與盲點；不確定的事情不會偽裝成確定。
 *
 * 懸空角的約定：以**與垂直面的夾角**表示。
 * 垂直牆 = 0°，水平朝下的天花板 = 90°。角度越大越需要支撐。
 * 這個約定與 BambuStudio UI 的 `support_threshold_angle` 未必數值相同，
 * 所以報告只說「幾何上有多陡」，不直接宣稱 Studio 會不會加支撐。
 */

export type PrintabilityOptions = {
  /** 機台可列印範圍，單位 mm。 */
  readonly buildVolume: Vec3;
  /** 超過這個角度視為需要留意的懸空。 */
  readonly overhangThresholdDegrees: number;
  /** 目前設定的擠出線寬，用來判斷特徵是否過薄。 */
  readonly lineWidthMm: number;
};

export const DEFAULT_PRINTABILITY_OPTIONS: PrintabilityOptions = {
  // Bambu Lab P1S／X1C 的實際可列印範圍。
  buildVolume: { x: 256, y: 256, z: 256 },
  overhangThresholdDegrees: 45,
  lineWidthMm: 0.42,
};

/**
 * 小於這個寬度的縫，幾乎可以確定是建模時沒接上，而不是刻意懸空的設計。
 * Tinkercad 拼方塊時對齊格點吸附差一格（1 mm）就是這個量級。
 */
const SEAM_GAP_MM = 2;

/**
 * @param parts 檔案本身的零件邊界（3MF／OBJ）。不給就把整包三角形當一個零件，
 *   浮空偵測會再依共用頂點拆殼，所以 STL 一樣抓得到。
 */
export function analysePrintability(
  triangles: readonly Triangle[],
  options: PrintabilityOptions = DEFAULT_PRINTABILITY_OPTIONS,
  parts?: readonly MeshPart[],
): PrintabilityReport {
  const inspection = inspectModel(triangles);
  const box = boundingBox(triangles);
  const findings: PrintabilityFinding[] = [];

  const fitsBuildVolume =
    box.size.x <= options.buildVolume.x &&
    box.size.y <= options.buildVolume.y &&
    box.size.z <= options.buildVolume.z;

  if (!fitsBuildVolume) {
    const scale = Math.min(
      options.buildVolume.x / box.size.x,
      options.buildVolume.y / box.size.y,
      options.buildVolume.z / box.size.z,
    );
    findings.push({
      code: 'exceeds-build-volume',
      severity: 'blocker',
      summary: `模型 ${fmt(box.size)} mm 超出列印範圍 ${fmt(options.buildVolume)} mm`,
      detail:
        `縮到 ${(scale * 100).toFixed(1)}% 以下才放得進去，` +
        '或是旋轉擺放、把模型切開分件列印。',
      relatedParameters: [],
    });
  }

  if (!inspection.closed) {
    findings.push({
      code: 'non-manifold',
      severity: 'warning',
      summary: `網格未封閉：有 ${inspection.openEdges} 條邊不是恰好由兩個三角形共用`,
      detail:
        '切片器仍可能印得出來，但內外判定會出錯，可能導致缺面、實心變空心或多餘的內壁。' +
        '正解是修復網格（Blender 3D Print Toolbox 或 Netfabb），不是靠切片參數補救。',
      relatedParameters: [],
    });
  }

  if (inspection.degenerateTriangles > 0) {
    findings.push({
      code: 'degenerate-geometry',
      severity: 'note',
      summary: `有 ${inspection.degenerateTriangles} 個面積為零的三角形`,
      detail: '多半是匯出時的殘留，通常無害，但會讓網格修復工具誤報。',
      relatedParameters: [],
    });
  }

  const floatingReport = findFloatingBodies(
    parts ?? [{ name: 'model', partId: '1', extruder: undefined, triangles }],
  );
  const floating = floatingReport.floating;
  if (floating.length > 0) {
    findings.push(floatingFinding(floating));
  }

  const overhang = measureOverhang(triangles, options.overhangThresholdDegrees, box.min.z);
  if (overhang.ratio > 0.02) {
    const severity = overhang.ratio > 0.2 ? 'warning' : 'note';
    findings.push({
      code: 'steep-overhang',
      severity,
      summary: `有 ${(overhang.ratio * 100).toFixed(1)}% 的表面積屬於超過 ${options.overhangThresholdDegrees}° 的朝下懸空`,
      detail:
        `最陡處達 ${overhang.maxDegrees.toFixed(1)}°（90° 等於完全水平的天花板）。` +
        '先考慮換擺放方向；方向無解時才開支撐。',
      relatedParameters: [
        'enable_support',
        'support_type',
        'support_threshold_angle',
        'enable_overhang_speed',
      ],
    });
  }

  const footprint = measureFootprintArea(triangles, box);
  const footprintRatio = footprint / Math.max(box.size.x * box.size.y, 1e-6);
  if (footprintRatio < 0.15 && box.size.z > 20) {
    findings.push({
      code: 'small-footprint',
      severity: 'warning',
      summary: `底面積僅約 ${footprint.toFixed(1)} mm²，佔投影面積 ${(footprintRatio * 100).toFixed(1)}%`,
      detail: '接觸面小的高件在列印中容易被噴頭撞倒或翹起。',
      relatedParameters: ['brim_type', 'brim_width', 'hot_plate_temp_initial_layer'],
    });
  }

  const base = Math.max(Math.min(box.size.x, box.size.y), 1e-6);
  const aspect = box.size.z / base;
  if (aspect > 5) {
    findings.push({
      code: 'tall-and-narrow',
      severity: 'note',
      summary: `高寬比約 ${aspect.toFixed(1)}:1`,
      detail:
        '細高件在高速移動時會晃動，造成上半部振紋甚至斷裂。降低外牆速度與加速度會有明顯改善。',
      relatedParameters: ['outer_wall_speed', 'default_acceleration', 'brim_type'],
    });
  }

  const minDimension = Math.min(box.size.x, box.size.y, box.size.z);
  if (minDimension < options.lineWidthMm * 2) {
    findings.push({
      code: 'thin-feature',
      severity: 'warning',
      summary: `最小整體尺寸 ${minDimension.toFixed(2)} mm 不到兩條擠出線寬（${(options.lineWidthMm * 2).toFixed(2)} mm）`,
      detail:
        '這種厚度切片器可能整段跳過不印。' +
        '注意這只檢查了整體外框；模型內部的薄壁必須實際切片才看得出來，本檢查不涵蓋。',
      relatedParameters: ['line_width', 'detect_thin_wall', 'layer_height'],
    });
  }

  const flatArea = box.size.x * box.size.y;
  if (flatArea > 10000 && footprintRatio > 0.6) {
    findings.push({
      code: 'large-flat-area',
      severity: 'note',
      summary: `底面接觸面積大（約 ${(flatArea * footprintRatio).toFixed(0)} mm²）`,
      detail:
        '大面積底面的收縮應力會集中在四角，是翹邊的典型形狀。高收縮材料要特別注意。',
      relatedParameters: ['brim_type', 'hot_plate_temp_initial_layer', 'fan_max_speed', 'draft_shield'],
    });
  }

  return {
    inspection,
    buildVolume: options.buildVolume,
    fitsBuildVolume,
    overhangAreaRatio: overhang.ratio,
    floatingBodies: floating.map((body) => ({
      name: body.name,
      partNames: body.partNames,
      liftMm: body.liftMm,
      nearestBody: body.nearestBody,
      gapMm: body.gapMm,
      gapAt: body.gapAt,
    })),
    findings: findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity)),
  };
}

function floatingFinding(floating: readonly FloatingBody[]): PrintabilityFinding {
  const seams = floating.filter((body) => body.gapMm !== undefined && body.gapMm <= SEAM_GAP_MM);
  const allSeams = seams.length === floating.length;
  const narrowest = Math.min(...floating.map((body) => body.gapMm ?? Infinity));

  const lines = floating.map((body) => {
    const where =
      body.gapMm === undefined || body.nearestBody === undefined
        ? '附近沒有其他實體'
        : `和「${body.nearestBody}」之間有 ${body.gapMm.toFixed(3)} mm 的縫`;
    return `「${body.name}」最低點離板 ${body.liftMm.toFixed(2)} mm，${where}`;
  });

  const advice = allSeams
    ? `這些縫都在 ${SEAM_GAP_MM} mm 以內，多半是建模時沒接上（Tinkercad 格點吸附差一格就是 1 mm）。` +
      '若真是如此，只開支撐是錯的修法：支撐會填進縫裡，拆掉後兩塊就分家；' +
      '正解是回建模軟體把零件移過去或拉長，讓兩者重疊 0.5 mm 以上，再合併群組（Tinkercad 是 Group）。' +
      `${SEAM_GAP_MM} mm 只是經驗門檻，不是判定：如果這是刻意留的活動間隙（列印即組裝的籠中球、關節），` +
      '千萬別把縫補起來，那塊照樣需要支撐，或改設計讓它落地。請先確認設計意圖。'
    : '寬縫的那幾塊是懸在空中的，需要開支撐或換擺放方向讓它有東西可以站；' +
      (seams.length > 0
        ? `另外 ${seams.length} 塊的縫在 ${SEAM_GAP_MM} mm 以內，多半是建模沒接上（要回建模軟體補，不是開支撐），` +
          '除非那是刻意留的活動間隙。'
        : '');

  return {
    code: 'floating-part',
    severity: 'blocker',
    summary:
      `有 ${floating.length} 塊實體沒有接到列印板` +
      (Number.isFinite(narrowest) ? `（最窄的縫 ${narrowest.toFixed(3)} mm）` : ''),
    detail:
      `${lines.join('；')}。${advice}` +
      'Bambu Studio 對這種情況報「Levitating objects cannot be printed without supports」或「floating regions」。' +
      '縫寬是模型原始尺寸，在 Studio 裡縮放後會等比例變化。',
    relatedParameters: allSeams ? [] : ['enable_support', 'support_type'],
  };
}

function severityRank(severity: PrintabilityFinding['severity']): number {
  switch (severity) {
    case 'blocker':
      return 0;
    case 'warning':
      return 1;
    case 'note':
      return 2;
  }
}

type OverhangMeasurement = { readonly ratio: number; readonly maxDegrees: number };

/**
 * 計算朝下且陡於門檻的表面積佔比。
 *
 * 對單位法向量 n，朝下時 n.z < 0，與垂直面的夾角為 asin(-n.z)：
 * n.z = 0（垂直牆）得 0°，n.z = -1（水平天花板）得 90°。
 *
 * 貼在熱床上的底面雖然也是「朝下的水平面」，但它直接躺在列印平台上不需要支撐，
 * 所以整個三角形都落在最低層內時排除。少了這個判斷，一個單純的方塊會被報成
 * 六分之一表面積需要支撐 —— 那是錯的。
 */
const BED_CONTACT_EPSILON = 1e-3;

function measureOverhang(
  triangles: readonly Triangle[],
  thresholdDegrees: number,
  minZ: number,
): OverhangMeasurement {
  let overhangArea = 0;
  let totalArea = 0;
  let maxDegrees = 0;

  for (const triangle of triangles) {
    const normal = faceNormal(triangle);
    if (normal === undefined) continue;
    const area = triangleArea(triangle);
    totalArea += area;

    if (normal.z >= 0) continue;

    const restsOnBed =
      Math.max(triangle.a.z, triangle.b.z, triangle.c.z) <= minZ + BED_CONTACT_EPSILON;
    if (restsOnBed) continue;

    const degrees = (Math.asin(Math.min(1, -normal.z)) * 180) / Math.PI;
    if (degrees > maxDegrees) maxDegrees = degrees;
    if (degrees > thresholdDegrees) overhangArea += area;
  }

  return {
    ratio: totalArea <= 0 ? 0 : overhangArea / totalArea,
    maxDegrees,
  };
}

/**
 * 估算與熱床接觸的面積：取最低點往上一層高度內、朝下的三角形。
 *
 * 這是投影近似而不是精確的首層截面；用於判斷「接觸面夠不夠大」這種量級問題已經足夠，
 * 但不能拿來當精確的首層面積。
 */
function measureFootprintArea(
  triangles: readonly Triangle[],
  box: ReturnType<typeof boundingBox>,
): number {
  const threshold = box.min.z + 0.25;
  let area = 0;

  for (const triangle of triangles) {
    const maxZ = Math.max(triangle.a.z, triangle.b.z, triangle.c.z);
    if (maxZ > threshold) continue;
    const normal = faceNormal(triangle);
    if (normal === undefined || normal.z >= -0.5) continue;
    // 投影到 XY 平面。
    area += triangleArea(triangle) * Math.abs(normal.z);
  }

  return area;
}

function fmt(v: Vec3): string {
  return `${v.x.toFixed(1)}×${v.y.toFixed(1)}×${v.z.toFixed(1)}`;
}
