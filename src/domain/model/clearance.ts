import type { BoundingBox, Vec3 } from '../contracts.js';
import type { MeshPart } from './threemf-reader.js';
import type { Triangle } from './stl.js';
import {
  boxDistance,
  distanceBetween,
  dot,
  enclosesXY,
  scaleAdd,
  subtract,
  TriangleSet,
} from './triangle-set.js';
import { surfacesTouch } from './contact.js';

/**
 * 零件之間的間隙量測。
 *
 * 為什麼需要這個：列印即組裝（print-in-place）的模型 —— 齒輪、鉸鏈、球窩關節 ——
 * 能不能動，取決於相鄰零件之間留了多少空隙，以及那個空隙有沒有大過印表機的解析能力。
 * 這件事在切片器裡看不到，在可列印性分析裡也看不到（那些只看單一實體的形狀），
 * 但它決定了成品是「會轉的機構」還是「一坨黏死的塑膠」。
 *
 * 兩個刻意的設計決定：
 *
 * 1. **零件不等於實體。** Bambu 把「同一顆實體依高度切成多段換色」也存成獨立的 part。
 *    直接拿 part 兩兩比對，會把同一顆齒輪的上下兩段報成「間隙 0，會黏死」——
 *    那是廢話，它們本來就是同一塊。所以先把互相接觸的 part 併成剛體，再比對剛體。
 *
 * 2. **量的是最小距離，不是中心距。** 齒輪的中心距算得出來，但真正會黏在一起的是
 *    齒面最接近的那一點。只有實際掃過表面才知道那一點在哪、離多遠。
 */

export type ClosestApproach = {
  readonly distanceMm: number;
  readonly at: Vec3;
};

export type MinDistanceOptions = {
  /** 取樣間距上限，mm。越小越準也越慢。 */
  readonly samplingMm: number;
  /** 單次比對的取樣點總數上限，避免大模型跑不完。 */
  readonly maxSamples: number;
};

export const DEFAULT_MIN_DISTANCE_OPTIONS: MinDistanceOptions = {
  samplingMm: 0.2,
  maxSamples: 250_000,
};

/** 在三角形上鋪均勻取樣點（含三個頂點）。用固定的重心座標格線，結果可重現。 */
function samplePoints(t: Triangle, spacing: number, maxSteps: number): readonly Vec3[] {
  const points: Vec3[] = [t.a, t.b, t.c];
  const ab = subtract(t.b, t.a);
  const ac = subtract(t.c, t.a);
  const longest = Math.sqrt(Math.max(dot(ab, ab), dot(ac, ac)));
  const steps = Math.min(maxSteps, Math.floor(longest / spacing));
  if (steps <= 1) return points;

  for (let i = 0; i <= steps; i += 1) {
    for (let j = 0; i + j <= steps; j += 1) {
      if (i === 0 && j === 0) continue;
      if (i === steps || j === steps) continue;
      points.push(scaleAdd(scaleAdd(t.a, ab, i / steps), ac, j / steps));
    }
  }
  return points;
}

/**
 * 先求一個有限的上界。
 *
 * 這一步不是最佳化，是正確性的前提：網格查詢需要有限的搜尋半徑，
 * 否則會一圈一圈往外擴到天邊，索引形同虛設。用抽樣的三角形互相比對，
 * 幾毫秒就能拿到一個夠用的上界。
 */
function seedUpperBound(a: TriangleSet, b: TriangleSet): number {
  const stride = (set: TriangleSet): number => Math.max(1, Math.floor(set.triangles.length / 120));
  const strideA = stride(a);
  const strideB = stride(b);

  let best = Infinity;
  for (let i = 0; i < a.triangles.length; i += strideA) {
    const ta = a.triangles[i];
    if (ta === undefined) continue;
    for (let j = 0; j < b.triangles.length; j += strideB) {
      const tb = b.triangles[j];
      if (tb === undefined) continue;
      const d = distanceBetween(ta.a, tb.a);
      if (d < best) best = d;
    }
  }

  if (Number.isFinite(best)) return best;
  // 兩邊都空或抽樣沒抽到東西時，退回用外框對角線當上界。
  const diagonal = (set: TriangleSet): number =>
    Math.sqrt(set.box.size.x ** 2 + set.box.size.y ** 2 + set.box.size.z ** 2);
  return diagonal(a) + diagonal(b) + boxDistance(a.box, b.box) + 1;
}

/**
 * 兩組三角形之間的最小距離。
 *
 * 三階段：抽樣求上界 → 頂點掃描收斂 → 對「離對方夠近」的三角形做面取樣細算。
 * 兩個方向都跑，因為最近點可能落在其中一邊的面內部而不是任何頂點上。
 *
 * 「有沒有接觸」不要用這支來問 —— 那是 contact.ts 的 surfacesTouch，便宜兩個數量級。
 */
export function minDistanceBetweenSets(
  a: TriangleSet,
  b: TriangleSet,
  options: MinDistanceOptions = DEFAULT_MIN_DISTANCE_OPTIONS,
): ClosestApproach | undefined {
  if (a.triangles.length === 0 || b.triangles.length === 0) return undefined;

  // 上界要「嚴格大於」真答案。網格查詢只回報比上界更近的點，
  // 如果上界剛好等於真答案（抽樣正好抽中最近的那對頂點就會這樣），
  // 查詢會一路回 undefined，最後什麼都沒找到。加一點餘裕把等號讓開。
  const seed = seedUpperBound(a, b);
  let best = seed + Math.max(1e-6, seed * 1e-9);
  let bestPoint: Vec3 | undefined;

  const sweep = (source: TriangleSet, target: TriangleSet, spacing: number | undefined): void => {
    let budget = options.maxSamples;

    // 由近而遠處理，這是分支限界能不能生效的關鍵。
    //
    // 照檔案順序掃的話，前面幾千個三角形可能都離對方很遠，best 一直降不下來，
    // 而 best 大就代表網格要往外搜很多圈 —— 每次查詢都貴。先排序，第一個處理的
    // 就是最可能最近的那個，best 立刻收斂到接近真值，後面全部被剪掉，
    // 而且因為已排序，一旦下界超過 best 就可以整個 break 掉，不必再看剩下的。
    const count = source.triangles.length;
    const lower = new Float64Array(count);
    for (let index = 0; index < count; index += 1) {
      lower[index] = source.lowerBoundToBox(index, target.box);
    }
    // 不要整個排序。
    //
    // 排序看起來很自然（由近而遠處理，分支限界最漂亮），但這條路徑每組零件比對要走四次、
    // 而齒圈有三萬五千個三角形 —— 一次比對就是上百萬次比較函式呼叫，實測整包 57 秒有一半在這裡。
    //
    // 真正需要的只是「先處理最近的少數幾個，把 best 壓下來」。壓下來之後，
    // 剩下的全部會被 `lower >= best` 這個 O(1) 判斷擋掉，順序就不重要了。
    // 選出最小的 K 個是線性的，不需要 O(n log n)。
    const SEED_COUNT = 48;
    const seedIndices: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const value = lower[index] ?? 0;
      if (seedIndices.length < SEED_COUNT) {
        seedIndices.push(index);
        if (seedIndices.length === SEED_COUNT) {
          seedIndices.sort((left, right) => (lower[left] ?? 0) - (lower[right] ?? 0));
        }
        continue;
      }
      const worst = seedIndices[SEED_COUNT - 1] ?? 0;
      if (value >= (lower[worst] ?? 0)) continue;
      seedIndices[SEED_COUNT - 1] = index;
      for (let k = SEED_COUNT - 1; k > 0; k -= 1) {
        const a = seedIndices[k] ?? 0;
        const b = seedIndices[k - 1] ?? 0;
        if ((lower[a] ?? 0) >= (lower[b] ?? 0)) break;
        seedIndices[k] = b;
        seedIndices[k - 1] = a;
      }
    }
    if (seedIndices.length < SEED_COUNT) {
      seedIndices.sort((left, right) => (lower[left] ?? 0) - (lower[right] ?? 0));
    }

    const visited = new Set(seedIndices);
    const order: number[] = [...seedIndices];
    for (let index = 0; index < count; index += 1) {
      if (!visited.has(index)) order.push(index);
    }

    for (const index of order) {
      const triangle = source.triangles[index];
      if (triangle === undefined) continue;
      if (budget <= 0) break;
      // 只有前 SEED_COUNT 個是排序過的，後面是原順序，所以這裡是 continue 不是 break。
      if ((lower[index] ?? 0) >= best) continue;

      let points: readonly Vec3[];
      if (spacing === undefined) {
        points = [triangle.a, triangle.b, triangle.c];
      } else {
        // 細算階段的閘門。
        //
        // 只靠上面那道 AABB 剪枝是不夠的：對方的外框可能很大（例如整個外齒圈），
        // 「離外框很近」不代表「離表面很近」。沒有這道閘，齒圈上成千上萬個
        // 其實離行星輪很遠的三角形都會被密集取樣，時間就是這樣燒掉的。
        //
        // 先用重心問一次：連「重心到對方表面」都超過 best 加上這個三角形自己的半徑，
        // 它上面就不可能有任何一點比 best 更近。一次查詢換掉幾十次取樣。
        const centroid = {
          x: (triangle.a.x + triangle.b.x + triangle.c.x) / 3,
          y: (triangle.a.y + triangle.b.y + triangle.c.y) / 3,
          z: (triangle.a.z + triangle.b.z + triangle.c.z) / 3,
        };
        const radius = Math.max(
          distanceBetween(centroid, triangle.a),
          distanceBetween(centroid, triangle.b),
          distanceBetween(centroid, triangle.c),
        );
        if (target.nearestWithin(centroid, best + radius) === undefined) continue;
        points = samplePoints(triangle, spacing, 6);
      }
      budget -= points.length;

      for (const point of points) {
        const hit = target.nearestWithin(point, best);
        if (hit === undefined) continue;
        best = hit.distance;
        // 回報位置取兩個最近點的中點，落在間隙正中間，比較好對照。
        bestPoint = {
          x: (point.x + hit.point.x) / 2,
          y: (point.y + hit.point.y) / 2,
          z: (point.z + hit.point.z) / 2,
        };
      }
    }
  };

  sweep(a, b, undefined);
  sweep(b, a, undefined);

  // 細算不能因為「只是分群」就跳過。
  //
  // 一度想省掉：分群只問是非題，貼合的面總會有頂點落在對方面上。
  // 但互相穿透的零件不是這樣 —— 一根柱子插進板子裡，兩邊的頂點可能都離對方表面好幾 mm，
  // 真正距離 0 的地方是柱子側面與板子頂面「交叉」的那條線，只有面取樣掃得到。
  // 跳過細算就會把插銷、嵌入的裝飾件判成獨立零件，然後報一個假的「間隙」。

  // 面取樣細算。間距取「目前最佳解的一半」與設定值的較小者，但不小於 0.02 mm。
  const refine = Math.max(0.02, Math.min(options.samplingMm, best / 2));
  sweep(a, b, refine);
  sweep(b, a, refine);

  if (bestPoint === undefined) return undefined;
  return { distanceMm: best, at: bestPoint };
}

/** 便利包裝，讓只有三角形陣列的呼叫端（例如測試）不必自己建索引。 */
export function minDistanceBetween(
  a: readonly Triangle[],
  b: readonly Triangle[],
  options: MinDistanceOptions = DEFAULT_MIN_DISTANCE_OPTIONS,
): ClosestApproach | undefined {
  return minDistanceBetweenSets(new TriangleSet(a), new TriangleSet(b), options);
}

// ── 剛體分群 ──────────────────────────────────────────────────────────────

export type RigidBody = {
  readonly index: number;
  readonly name: string;
  /** 併進這個剛體的 3MF 零件名稱。 */
  readonly partNames: readonly string[];
  readonly extruders: readonly string[];
  readonly triangleCount: number;
  readonly boundingBox: BoundingBox;
  readonly set: TriangleSet;
};

/**
 * 把互相接觸的零件併成剛體。
 *
 * 判準是「最小距離小於 fuseEpsilon」。同一顆實體被切成的換色段落是完全貼合的（距離 0），
 * 嵌在環上的裝飾球也是（互相穿透，距離 0），而真正分離的機構件之間隔著設計公差，
 * 不會被誤併 —— 這是行星齒輪陀螺上實測 0.09 mm 的那個間隙。
 */
export function groupRigidBodies(parts: readonly MeshPart[], fuseEpsilon = 1e-3): readonly RigidBody[] {
  const sets = parts.map((part) => new TriangleSet(part.triangles));
  const parent = parts.map((_, index) => index);

  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root] ?? root;
    return root;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  for (let i = 0; i < parts.length; i += 1) {
    for (let j = i + 1; j < parts.length; j += 1) {
      if (find(i) === find(j)) continue;
      const setI = sets[i];
      const setJ = sets[j];
      if (setI === undefined || setJ === undefined) continue;
      // AABB 都碰不到就不可能接觸。這一行擋掉絕大多數配對。
      if (boxDistance(setI.box, setJ.box) > fuseEpsilon) continue;

      // 用專用的接觸判定，不要借用最小距離。
      //
      // 借用的話等於為了一個是非題去算精確值：搜尋半徑是「目前最佳解」（可能好幾 mm），
      // 網格得往外搜很多圈。接觸判定的半徑固定是 fuseEpsilon（1 微米量級），
      // 幾乎每次查詢都只看一格。實測這一個改動把分群從數分鐘壓到不到一秒。
      if (surfacesTouch(setI, setJ, fuseEpsilon)) union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let index = 0; index < parts.length; index += 1) {
    const root = find(index);
    const bucket = groups.get(root);
    if (bucket === undefined) groups.set(root, [index]);
    else bucket.push(index);
  }

  const bodies: RigidBody[] = [];
  let ordinal = 0;
  for (const members of groups.values()) {
    const memberParts = members
      .map((index) => parts[index])
      .filter((part): part is MeshPart => part !== undefined);
    const triangles = memberParts.flatMap((part) => part.triangles);
    if (triangles.length === 0) continue;

    const extruders = [
      ...new Set(
        memberParts
          .map((part) => part.extruder)
          .filter((value): value is string => value !== undefined),
      ),
    ].sort();

    const set = new TriangleSet(triangles);
    bodies.push({
      index: ordinal,
      name: memberParts[0]?.name ?? `body_${ordinal + 1}`,
      partNames: memberParts.map((part) => part.name),
      extruders,
      triangleCount: triangles.length,
      boundingBox: set.box,
      set,
    });
    ordinal += 1;
  }

  return bodies;
}

// ── 報告 ──────────────────────────────────────────────────────────────────

export type ClearanceVerdict = 'will-fuse' | 'marginal' | 'adequate';

export type ClearancePair = {
  readonly a: string;
  readonly b: string;
  readonly gapMm: number;
  readonly at: Vec3;
  readonly verdict: ClearanceVerdict;
  /**
   * 這個介面上，是誰包住誰。
   * `a-encloses-b` 代表 a 那一側是「孔」，吃 xy_hole_compensation；
   * 兩邊都不是包覆關係時是 `neither`，兩側都吃 xy_contour_compensation。
   */
  readonly enclosure: 'a-encloses-b' | 'b-encloses-a' | 'neither';
};

export type ClearanceReport = {
  readonly format: string;
  readonly partCount: number;
  readonly bodies: readonly {
    readonly name: string;
    readonly partNames: readonly string[];
    readonly extruders: readonly string[];
    readonly triangleCount: number;
    readonly boundingBox: BoundingBox;
  }[];
  readonly pairs: readonly ClearancePair[];
  readonly tightestGapMm: number | undefined;
  readonly minimumClearanceMm: number;
  readonly findings: readonly string[];
  readonly recommendation:
    | {
        readonly xy_contour_compensation: string;
        readonly xy_hole_compensation: string;
        readonly rationale: string;
      }
    | undefined;
};

export type ClearanceOptions = {
  /** 這台機器／材料能可靠印出的最小間隙。0.4 噴頭 PLA 的實務下限約 0.15–0.20 mm。 */
  readonly minimumClearanceMm: number;
  /** 超過這個距離的配對不列入報告，避免無關的零件洗版。 */
  readonly reportThresholdMm: number;
  /** 小於這個距離就視為同一顆實體。 */
  readonly fuseEpsilonMm: number;
};

export const DEFAULT_CLEARANCE_OPTIONS: ClearanceOptions = {
  minimumClearanceMm: 0.15,
  reportThresholdMm: 2,
  fuseEpsilonMm: 1e-3,
};

function verdictOf(gap: number, minimum: number): ClearanceVerdict {
  if (gap < minimum) return 'will-fuse';
  if (gap < minimum * 1.5) return 'marginal';
  return 'adequate';
}

export function analyseClearance(
  parts: readonly MeshPart[],
  format: string,
  options: ClearanceOptions = DEFAULT_CLEARANCE_OPTIONS,
  distanceOptions: MinDistanceOptions = DEFAULT_MIN_DISTANCE_OPTIONS,
): ClearanceReport {
  const bodies = groupRigidBodies(parts, options.fuseEpsilonMm);
  const pairs: ClearancePair[] = [];

  for (let i = 0; i < bodies.length; i += 1) {
    for (let j = i + 1; j < bodies.length; j += 1) {
      const bodyA = bodies[i];
      const bodyB = bodies[j];
      if (bodyA === undefined || bodyB === undefined) continue;
      if (boxDistance(bodyA.boundingBox, bodyB.boundingBox) > options.reportThresholdMm) continue;

      const hit = minDistanceBetweenSets(bodyA.set, bodyB.set, distanceOptions);
      if (hit === undefined || hit.distanceMm > options.reportThresholdMm) continue;

      pairs.push({
        a: bodyA.name,
        b: bodyB.name,
        gapMm: hit.distanceMm,
        at: hit.at,
        verdict: verdictOf(hit.distanceMm, options.minimumClearanceMm),
        enclosure: enclosesXY(bodyA.boundingBox, bodyB.boundingBox)
          ? 'a-encloses-b'
          : enclosesXY(bodyB.boundingBox, bodyA.boundingBox)
            ? 'b-encloses-a'
            : 'neither',
      });
    }
  }

  pairs.sort((left, right) => left.gapMm - right.gapMm);

  const tightest = pairs[0]?.gapMm;
  const findings: string[] = [];

  if (bodies.length <= 1) {
    findings.push(
      '只找到一顆實體，沒有可以互相移動的零件。這個模型不是列印即組裝的機構，' +
        '或是所有零件在設計上就已經連在一起。',
    );
  }

  const fusing = pairs.filter((pair) => pair.verdict === 'will-fuse');
  const marginal = pairs.filter((pair) => pair.verdict === 'marginal');

  if (fusing.length > 0) {
    findings.push(
      `${fusing.length} 組介面的間隙小於 ${options.minimumClearanceMm} mm，` +
        '照原尺寸列印會熔在一起。硬扳可以分開，但齒面會撕裂，動作不會順。',
    );
  }
  if (marginal.length > 0) {
    findings.push(`${marginal.length} 組介面在臨界區間，能不能動取決於首層壓扁程度與流量校正。`);
  }
  if (pairs.length > 0 && fusing.length === 0 && marginal.length === 0) {
    findings.push('所有介面的間隙都在可靠區間，不需要為了轉動而調整補償。');
  }

  let recommendation: ClearanceReport['recommendation'];
  if (tightest !== undefined && tightest < options.minimumClearanceMm) {
    // 每一側各縮／擴這麼多，兩側加起來剛好補到門檻。量化到 0.005 mm 一階，方便直接填進 Studio。
    //
    // 那個 1e-9 不是裝飾：0.15 - 0.09 在浮點裡是 0.06000000000000005，
    // 乘 200 得 6.000000000000005，ceil 會進位到 7，於是本來剛好的 0.030 被吹成 0.035。
    // 建議值憑空多讓 0.005 mm，齒厚就白白被吃掉。
    const perSide = Math.ceil(((options.minimumClearanceMm - tightest) / 2) * 200 - 1e-9) / 200;
    const hasEnclosure = pairs.some(
      (pair) => pair.verdict === 'will-fuse' && pair.enclosure !== 'neither',
    );
    recommendation = {
      xy_contour_compensation: `-${perSide.toFixed(3)}`,
      xy_hole_compensation: hasEnclosure ? `${perSide.toFixed(3)}` : '0',
      rationale:
        `最緊的介面是 ${tightest.toFixed(3)} mm，目標 ${options.minimumClearanceMm} mm，` +
        `兩側各讓 ${perSide.toFixed(3)} mm 剛好補上。` +
        (hasEnclosure
          ? '注意有零件被另一個零件包住：被包住那一側的面在切片器眼中是「孔」，' +
            '吃 xy_hole_compensation（正值擴大），不是 xy_contour_compensation。' +
            '只調其中一個，間隙只會長一半。'
          : '沒有包覆關係，兩側都是外輪廓，只要調 xy_contour_compensation。') +
        ' 另外務必確認 detect_thin_wall 是關的 —— 開著切片器會試圖把這些縫填起來。',
    };
  }

  return {
    format,
    partCount: parts.length,
    bodies: bodies.map((body) => ({
      name: body.name,
      partNames: body.partNames,
      extruders: body.extruders,
      triangleCount: body.triangleCount,
      boundingBox: body.boundingBox,
    })),
    pairs,
    tightestGapMm: tightest,
    minimumClearanceMm: options.minimumClearanceMm,
    findings,
    recommendation,
  };
}
