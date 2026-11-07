import type { BoundingBox, Vec3 } from '../contracts.js';
import { groupRigidBodies, minDistanceBetweenSets, type RigidBody } from './clearance.js';
import { boundingBox, type Triangle } from './stl.js';
import type { MeshPart } from './threemf-reader.js';
import { boxDistance, dot, subtract } from './triangle-set.js';

/**
 * 浮空實體偵測：哪些實體沒有接到列印板。
 *
 * 實際踩到的案例（2026-11-07 生日蛋糕插牌）：Tinkercad 用十個方塊拼成的模型，
 * 兩隻腳頂在 z=50、身體底從 z=51 開始，中間 1 mm 的縫肉眼看不出來。Bambu Studio 報
 * 「Levitating objects cannot be printed without supports」，但只開支撐是錯的 ——
 * 支撐會填進那條縫，拆掉後腳和身體斷成兩截。
 *
 * 整體外框與懸空角都抓不到這件事：模型最低點確實在板子上（腳），每個面的角度也正常。
 * 要看的是**連通性**：把幾何拆成殼、把互相接觸或穿透的殼併成實體，再看每個實體碰不碰得到板子。
 *
 * 三層合併：
 * 1. 殼：共用頂點的三角形屬於同一個殼（同一個 Tinkercad 基本形狀）。
 * 2. 接觸：表面貼合或互相穿透的殼是同一顆實體（交給 groupRigidBodies，跟間隙量測同一套判準）。
 * 3. 包含：整個藏在另一個實體內部的殼（例如被橫幅包住的眼睛）沒有任何表面接觸，
 *    但切片時會被聯集吃掉，不能報成浮空。用射線奇偶測試判斷。
 */

export type FloatingBody = {
  readonly name: string;
  readonly partNames: readonly string[];
  readonly boundingBox: BoundingBox;
  /** 這塊實體最低點離列印板的高度。 */
  readonly liftMm: number;
  /** 離它最近的另一塊實體（通常就是該接上去的那塊）。 */
  readonly nearestBody: string | undefined;
  /** 與最近實體之間的最小距離；就是那條縫的寬度。 */
  readonly gapMm: number | undefined;
  readonly gapAt: Vec3 | undefined;
};

export type FloatingReport = {
  readonly bodyCount: number;
  readonly groundedBodyCount: number;
  readonly floating: readonly FloatingBody[];
};

export type FloatingOptions = {
  /** 實體最低點離板子在這個距離內就算有接到。 */
  readonly bedToleranceMm: number;
  /** 小於這個距離視為接觸。 */
  readonly fuseEpsilonMm: number;
  /** 找最近實體時，外框距離超過這個值就不比對。 */
  readonly neighbourSearchMm: number;
};

export const DEFAULT_FLOATING_OPTIONS: FloatingOptions = {
  bedToleranceMm: 0.01,
  fuseEpsilonMm: 1e-3,
  neighbourSearchMm: 20,
};

// ── 殼 ──────────────────────────────────────────────────────────────────

const QUANTUM = 1e5;

function vertexKey(v: Vec3): string {
  return `${Math.round(v.x * QUANTUM)},${Math.round(v.y * QUANTUM)},${Math.round(v.z * QUANTUM)}`;
}

/**
 * 依共用頂點把三角形分成連通的殼。
 *
 * STL 是整包三角形湯，Tinkercad 匯出時每個基本形狀還是各自一個殼；
 * 3MF／OBJ 的單一零件裡也可能有好幾個殼（例如文字的每個字母）。
 */
export function splitShells(triangles: readonly Triangle[]): readonly (readonly Triangle[])[] {
  const ids = new Map<string, number>();
  const parent: number[] = [];

  const idOf = (v: Vec3): number => {
    const key = vertexKey(v);
    let id = ids.get(key);
    if (id === undefined) {
      id = parent.length;
      ids.set(key, id);
      parent.push(id);
    }
    return id;
  };
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root] ?? root;
    // 路徑壓縮：大網格（數十萬頂點）沒有這步會退化成線性鏈。
    let cursor = index;
    while (parent[cursor] !== root) {
      const next = parent[cursor] ?? root;
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  const corners = triangles.map((t) => [idOf(t.a), idOf(t.b), idOf(t.c)] as const);
  for (const [a, b, c] of corners) {
    union(a, b);
    union(b, c);
  }

  const shells = new Map<number, Triangle[]>();
  triangles.forEach((triangle, index) => {
    const root = find(corners[index]?.[0] ?? 0);
    const bucket = shells.get(root);
    if (bucket === undefined) shells.set(root, [triangle]);
    else bucket.push(triangle);
  });

  return [...shells.values()];
}

// ── 包含 ────────────────────────────────────────────────────────────────

/**
 * 點是否在封閉網格內部（射線奇偶法）。
 *
 * 射線方向故意取一個不對齊任何軸的方向：沿軸射線很容易剛好掃過方塊的稜線或頂點，
 * 一條稜線被兩個三角形各算一次，奇偶就錯了。
 */
const RAY = (() => {
  const raw = { x: 0.1234, y: 0.2345, z: 0.9643 };
  const length = Math.sqrt(dot(raw, raw));
  return { x: raw.x / length, y: raw.y / length, z: raw.z / length };
})();

function rayHits(origin: Vec3, t: Triangle): boolean {
  const edge1 = subtract(t.b, t.a);
  const edge2 = subtract(t.c, t.a);
  const h = {
    x: RAY.y * edge2.z - RAY.z * edge2.y,
    y: RAY.z * edge2.x - RAY.x * edge2.z,
    z: RAY.x * edge2.y - RAY.y * edge2.x,
  };
  const determinant = dot(edge1, h);
  if (Math.abs(determinant) < 1e-12) return false;
  const inverse = 1 / determinant;
  const s = subtract(origin, t.a);
  const u = inverse * dot(s, h);
  if (u < 0 || u > 1) return false;
  const q = {
    x: s.y * edge1.z - s.z * edge1.y,
    y: s.z * edge1.x - s.x * edge1.z,
    z: s.x * edge1.y - s.y * edge1.x,
  };
  const v = inverse * dot(RAY, q);
  if (v < 0 || u + v > 1) return false;
  return inverse * dot(edge2, q) > 1e-9;
}

export function pointInsideMesh(point: Vec3, triangles: readonly Triangle[]): boolean {
  let crossings = 0;
  for (const triangle of triangles) {
    if (rayHits(point, triangle)) crossings += 1;
  }
  return crossings % 2 === 1;
}

function boxContains(outer: BoundingBox, inner: BoundingBox): boolean {
  return (
    outer.min.x <= inner.min.x &&
    outer.min.y <= inner.min.y &&
    outer.min.z <= inner.min.z &&
    outer.max.x >= inner.max.x &&
    outer.max.y >= inner.max.y &&
    outer.max.z >= inner.max.z
  );
}

// ── 主流程 ──────────────────────────────────────────────────────────────

/** 只有真的會印出來的零件才算數；挖除體、修飾體、支撐控制體都不是實體。 */
function isSolid(part: MeshPart): boolean {
  return part.subtype === undefined || part.subtype === 'normal_part';
}

export function findFloatingBodies(
  parts: readonly MeshPart[],
  options: FloatingOptions = DEFAULT_FLOATING_OPTIONS,
): FloatingReport {
  // 殼的名稱必須唯一：分群結果只帶回名稱，要靠名稱對回殼。3MF 裡同名零件很常見。
  const used = new Map<string, number>();
  const unique = (name: string): string => {
    const count = used.get(name) ?? 0;
    used.set(name, count + 1);
    return count === 0 ? name : `${name}~${count + 1}`;
  };
  const shells: MeshPart[] = parts.filter(isSolid).flatMap((part) => {
    const pieces = splitShells(part.triangles);
    return pieces.map((triangles, index) => ({
      ...part,
      name: unique(pieces.length === 1 ? part.name : `${part.name}#${index + 1}`),
      triangles,
    }));
  });
  const shellBoxes = shells.map((shell) => boundingBox(shell.triangles));

  const bodies = groupRigidBodies(shells, options.fuseEpsilonMm);
  if (bodies.length === 0) return { bodyCount: 0, groundedBodyCount: 0, floating: [] };

  const bodyOfShell = new Map<string, number>();
  bodies.forEach((body, index) => {
    for (const name of body.partNames) bodyOfShell.set(name, index);
  });

  const bedZ = Math.min(...bodies.map((body) => body.boundingBox.min.z));

  // 包含關係：被另一塊實體整個包住的實體，跟外面那塊算同一塊。
  //
  // 奇偶測試必須逐「殼」做，不能拿整塊實體的三角形去數。一塊實體常是好幾個互相穿透的
  // 封閉殼（Tinkercad 的方塊疊在一起），點同時落在兩個重疊的殼裡時，交點數是奇＋奇＝偶，
  // 會被誤判成在外面。真實模型上實測：被橫幅包住的字母因此被報成浮空。
  const parent = bodies.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root] ?? root;
    return root;
  };
  for (let i = 0; i < bodies.length; i += 1) {
    const inner = bodies[i];
    const probe = inner?.set.triangles[0]?.a;
    if (inner === undefined || probe === undefined) continue;
    for (let k = 0; k < shells.length; k += 1) {
      const shell = shells[k];
      const box = shellBoxes[k];
      const j = shell === undefined ? undefined : bodyOfShell.get(shell.name);
      if (shell === undefined || box === undefined || j === undefined || j === i) continue;
      if (!boxContains(box, inner.boundingBox)) continue;
      if (pointInsideMesh(probe, shell.triangles)) {
        const rootI = find(i);
        const rootJ = find(j);
        if (rootI !== rootJ) parent[rootI] = rootJ;
        break;
      }
    }
  }

  const clusters = new Map<number, RigidBody[]>();
  bodies.forEach((body, index) => {
    const root = find(index);
    const bucket = clusters.get(root);
    if (bucket === undefined) clusters.set(root, [body]);
    else bucket.push(body);
  });

  const grounded = new Set<RigidBody>();
  const floatingClusters: RigidBody[][] = [];
  for (const members of clusters.values()) {
    const lowest = Math.min(...members.map((body) => body.boundingBox.min.z));
    if (lowest - bedZ <= options.bedToleranceMm) for (const body of members) grounded.add(body);
    else floatingClusters.push(members);
  }

  const floating: FloatingBody[] = floatingClusters.map((members) => {
    // 名稱與外框取「外層」那塊：包含合併時被包住的放在後面。
    const sorted = [...members].sort(
      (left, right) => right.set.triangles.length - left.set.triangles.length,
    );
    const main = sorted[0] as RigidBody;
    const lowest = Math.min(...members.map((body) => body.boundingBox.min.z));

    // 最近的實體優先找「站在板子上的」：那才是它該接上去的對象。
    // 不然兩塊都浮空的字母會互相指認，報出一條跟問題無關的縫。
    const nearestAmong = (candidates: readonly RigidBody[]) => {
      let best: { body: RigidBody; distanceMm: number; at: Vec3 } | undefined;
      for (const other of candidates) {
        if (boxDistance(main.boundingBox, other.boundingBox) > options.neighbourSearchMm) continue;
        const hit = minDistanceBetweenSets(main.set, other.set);
        if (hit !== undefined && (best === undefined || hit.distanceMm < best.distanceMm)) {
          best = { body: other, distanceMm: hit.distanceMm, at: hit.at };
        }
      }
      return best;
    };
    const nearest =
      nearestAmong([...grounded]) ?? nearestAmong(bodies.filter((body) => !members.includes(body)));
    const nearestBody = nearest?.body.name;
    const gapMm = nearest?.distanceMm;
    const gapAt = nearest?.at;

    return {
      name: main.name,
      partNames: members.flatMap((body) => body.partNames),
      boundingBox: main.boundingBox,
      liftMm: lowest - bedZ,
      nearestBody,
      gapMm,
      gapAt,
    };
  });

  floating.sort((left, right) => left.liftMm - right.liftMm);

  return {
    bodyCount: clusters.size,
    groundedBodyCount: clusters.size - floatingClusters.length,
    floating,
  };
}
