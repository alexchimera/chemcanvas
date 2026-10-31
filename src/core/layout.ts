import {
  add,
  angleDiff,
  angleOf,
  deg,
  dist,
  dot,
  meanPoint,
  normalize,
  pointInPolygon,
  polar,
  scale,
  segmentIntersection,
  sub,
  TAU,
  type Vec,
} from './geometry';
import type { BondStereo, Molecule } from './molecule';
import { nearestLatticePoint, polygonAtVertex, polygonOnBond, regularPolygon } from './placement';
import { findRings, type Ring } from './rings';

/**
 * Structure clean-up: redraw each molecule with ideal geometry (unit bonds,
 * regular rings, 120° zig-zags, linear alkynes) while keeping what the drawing
 * says: which side each substituent is on, cis/trans double bonds, wedge
 * stereocentres, and roughly where and which way round the molecule sits.
 *
 * Ring systems are built from regular polygons and placed as rigid units;
 * everything else grows outward from the largest ring system along the tree
 * of acyclic bonds, each bond taking the ideal direction nearest to the one
 * drawn. Overlaps are then untangled by mirroring branches across single
 * bonds, and the result is turned back onto the drawing's orientation.
 */

type Pos = Map<number, Vec>;

export interface CleanupOptions {
  /** Square each structure onto the nearest 30° grid orientation (default true). */
  straighten?: boolean;
  /** Then move it onto the hex lattice when its bonds allow (default false). */
  lattice?: boolean;
}

export interface CleanupResult {
  /** New positions for every atom of the structures that were cleaned. */
  positions: Map<number, Vec>;
  /** Wedges and hashes swapped so mirrored branches keep their configuration. */
  stereo: Map<number, BondStereo>;
  /** How far the most-moved atom travels. */
  maxShift: number;
}

/** Clean up the molecules containing `scope` (default: every molecule). */
export function cleanupLayout(mol: Molecule, scope?: Iterable<number>, opts: CleanupOptions = {}): CleanupResult {
  const rings = findRings(mol);
  const wanted = scope ? new Set(scope) : null;
  const all = mol.components();
  const targets = all.filter((f) => f.length > 1 && (!wanted || f.some((a) => wanted.has(a))));
  const positions: Pos = new Map();
  const stereo = new StereoTracker(mol);

  for (const frag of targets) {
    const inFrag = new Set(frag);
    const fragRings = rings.filter((r) => inFrag.has(r.atoms[0]));
    const pos = layoutFragment(mol, frag, fragRings);
    resolveClashes(mol, frag, pos, fragRings, stereo);
    // Back where it was, the way round it was.
    const fit = fitRigid(
      frag.map((id) => pos.get(id)!),
      frag.map((id) => mol.pos(id)),
      false,
    );
    for (const id of frag) pos.set(id, applyRigid(fit, pos.get(id)!));
    if (opts.straighten ?? true) straighten(mol, frag, pos);
    if (opts.lattice) snapToLattice(mol, frag, pos);
    for (const id of frag) positions.set(id, pos.get(id)!);
  }

  separate(mol, all, targets, positions, opts.lattice ?? false);
  let maxShift = 0;
  for (const [id, p] of positions) maxShift = Math.max(maxShift, dist(p, mol.pos(id)));
  return { positions, stereo: stereo.changes(), maxShift };
}

/** Apply a clean-up result to the molecule. */
export function applyCleanup(mol: Molecule, result: CleanupResult): void {
  for (const [id, p] of result.positions) mol.updateAtom(id, { x: p.x, y: p.y });
  for (const [id, stereo] of result.stereo) mol.updateBond(id, { stereo });
}

// ——— Assembling a molecule ———

/** Maps a drawn direction around an atom to the new layout. */
interface Frame {
  theta: number;
  reflect: boolean;
}

const mapDir = (f: Frame, a: number) => (f.reflect ? -a : a) + f.theta;

function layoutFragment(mol: Molecule, frag: number[], rings: Ring[]): Pos {
  const orig = (id: number) => mol.pos(id);
  const systems = ringSystems(rings);
  const systemOf = new Map<number, number>();
  systems.forEach((sys, i) => sys.forEach((r) => r.atoms.forEach((a) => systemOf.set(a, i))));
  const local = systems.map((sys) => constructRings(sys, orig) ?? relaxedRings(mol, sys));
  const ringsOf = new Map<number, Ring[]>();
  for (const r of rings) for (const a of r.atoms) ringsOf.set(a, [...(ringsOf.get(a) ?? []), r]);

  const pos: Pos = new Map();
  const frame = new Map<number, Frame>();
  const turn = new Map<number, number>();
  const queue: number[] = [];

  const placeSystem = (coords: Pos) => {
    const ids = [...coords.keys()];
    const fit = fitRigid(ids.map(orig), ids.map((id) => coords.get(id)!), true);
    for (const id of ids) {
      pos.set(id, coords.get(id)!);
      frame.set(id, { theta: fit.theta, reflect: fit.reflect });
      turn.set(id, 0);
      queue.push(id);
    }
  };

  if (systems.length) {
    const root = systems.reduce((best, _, i) => (local[i].size > local[best].size ? i : best), 0);
    const ids = [...local[root].keys()];
    const fit = fitRigid(ids.map((id) => local[root].get(id)!), ids.map(orig), true);
    placeSystem(new Map(ids.map((id) => [id, applyRigid(fit, local[root].get(id)!)])));
  } else {
    const root = graphCenter(mol, frag);
    pos.set(root, orig(root));
    frame.set(root, { theta: 0, reflect: false });
    turn.set(root, 0);
    queue.push(root);
  }

  while (queue.length) {
    const v = queue.shift()!;
    const kids = mol.neighbors(v).filter((n) => !pos.has(n));
    if (!kids.length) continue;
    const pv = pos.get(v)!;
    const placed = mol.neighbors(v).filter((n) => pos.has(n));
    const f = frame.get(v)!;
    const predict = (c: number) => mapDir(f, angleOf(sub(orig(c), orig(v))));
    const centers = (ringsOf.get(v) ?? []).map((r) => meanPoint(r.atoms.map((a) => pos.get(a)!)));
    const dirs = chooseDirections(mol, v, pv, placed, pos, centers, kids, predict, turn.get(v) ?? 0);

    for (const c of kids) {
      const d = dirs.get(c)!;
      const sys = systemOf.get(c);
      if (sys !== undefined) {
        placeSystem(attachSystem(local[sys], systems[sys], c, add(pv, polar(d)), d, v, pv, f, orig));
        continue;
      }
      const pc = add(pv, polar(d));
      pos.set(c, pc);
      const back = angleOf(sub(pv, pc));
      frame.set(c, { reflect: f.reflect, theta: back - (f.reflect ? -1 : 1) * angleOf(sub(orig(v), orig(c))) });
      const incoming = placed.length === 1 ? angleOf(sub(pv, pos.get(placed[0])!)) : null;
      const sign = incoming === null ? 0 : Math.sign(Math.round(angleDiff(d, incoming) * 1e6));
      turn.set(c, sign || (turn.get(v) ?? 0));
      queue.push(c);
    }
  }
  return pos;
}

/**
 * Directions for the unplaced neighbours (`kids`) of a placed atom: the
 * ideal set for its bonding, matched to the drawing without changing the
 * order of substituents around the atom.
 */
function chooseDirections(
  mol: Molecule,
  v: number,
  pv: Vec,
  placed: number[],
  pos: Pos,
  centers: Vec[],
  kids: number[],
  predict: (c: number) => number,
  turnV: number,
): Map<number, number> {
  const out = new Map<number, number>();
  const m = kids.length;
  const linear = isLinear(mol, v);

  if (placed.length === 0) {
    const pattern =
      m === 1
        ? [0]
        : m === 2
          ? [0, linear ? Math.PI : (2 * Math.PI) / 3]
          : m === 4
            ? [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]
            : Array.from({ length: m }, (_, k) => (TAU * k) / m);
    assignWithRotation(kids, pattern, predict, out);
    return out;
  }

  if (placed.length === 1) {
    const back = angleOf(sub(pos.get(placed[0])!, pv));
    const incoming = back + Math.PI;
    if (m === 1) {
      const c = kids[0];
      if (linear) {
        out.set(c, incoming);
        return out;
      }
      const options = [incoming + Math.PI / 3, incoming - Math.PI / 3];
      const p = predict(c);
      const doubleBond = mol.bondBetween(v, placed[0])?.order === 2 || mol.bondBetween(v, c)?.order === 2;
      const straightOn = Math.abs(angleDiff(p, incoming)) < (doubleBond ? deg(8) : deg(20));
      const pick = straightOn
        ? turnV > 0
          ? options[1]
          : options[0]
        : Math.abs(angleDiff(p, options[0])) <= Math.abs(angleDiff(p, options[1]))
          ? options[0]
          : options[1];
      out.set(c, pick);
      return out;
    }
    const spread =
      m === 2
        ? [back + (2 * Math.PI) / 3, back + (4 * Math.PI) / 3]
        : m === 3
          ? [back + Math.PI / 2, back + Math.PI, back + (3 * Math.PI) / 2]
          : Array.from({ length: m }, (_, k) => back + (TAU * (k + 1)) / (m + 1));
    assignInOrder(kids, spread, back, predict, out);
    return out;
  }

  const open = openDirections(
    pv,
    placed.map((n) => pos.get(n)!),
    centers,
    m,
  );
  assignInOrder(kids, open.dirs, open.ref, predict, out);
  return out;
}

const normAngle = (a: number) => ((a % TAU) + TAU) % TAU;

/** Pair kids with directions in the same counter-clockwise order, starting from `ref`. */
function assignInOrder(kids: number[], dirs: number[], ref: number, predict: (c: number) => number, out: Map<number, number>) {
  const off = (a: number) => normAngle(a - ref);
  const sortedKids = [...kids].sort((x, y) => off(predict(x)) - off(predict(y)));
  const sortedDirs = [...dirs].sort((x, y) => off(x) - off(y));
  sortedKids.forEach((c, i) => out.set(c, sortedDirs[i]));
}

/** Like assignInOrder, but the whole pattern may also be rotated to fit the drawing. */
function assignWithRotation(kids: number[], pattern: number[], predict: (c: number) => number, out: Map<number, number>) {
  const sorted = [...kids].sort((x, y) => normAngle(predict(x)) - normAngle(predict(y)));
  const m = sorted.length;
  let best = { cost: Infinity, shift: 0, rot: 0 };
  for (let s = 0; s < m; s++) {
    let sx = 0;
    let sy = 0;
    sorted.forEach((c, i) => {
      const a = predict(c) - pattern[(i + s) % m];
      sx += Math.cos(a);
      sy += Math.sin(a);
    });
    const rot = Math.atan2(sy, sx);
    const cost = sorted.reduce((acc, c, i) => acc + angleDiff(predict(c), pattern[(i + s) % m] + rot) ** 2, 0);
    if (cost < best.cost - 1e-9) best = { cost, shift: s, rot };
  }
  sorted.forEach((c, i) => out.set(c, pattern[(i + best.shift) % m] + best.rot));
}

/**
 * Directions spread evenly through the roomiest gap around a ring atom that
 * no ring fills; `ref` is where that gap starts.
 */
function openDirections(center: Vec, neighbors: Vec[], ringCenters: Vec[], count: number): { dirs: number[]; ref: number } {
  if (!neighbors.length) return { dirs: Array.from({ length: count }, (_, k) => (TAU * k) / count), ref: 0 };
  const angles = neighbors.map((p) => normAngle(angleOf(sub(p, center)))).sort((a, b) => a - b);
  const filled = ringCenters.map((c) => normAngle(angleOf(sub(c, center))));
  let from = angles[0];
  let size = -1;
  let free = false;
  for (let i = 0; i < angles.length; i++) {
    const start = angles[i];
    const gap = (i + 1 < angles.length ? angles[i + 1] : angles[0] + TAU) - start;
    const isFree = !filled.some((a) => {
      const off = normAngle(a - start);
      return off > 1e-6 && off < gap - 1e-6;
    });
    if ((isFree && !free) || (isFree === free && gap > size + 1e-9)) {
      from = start;
      size = gap;
      free = isFree;
    }
  }
  return { dirs: Array.from({ length: count }, (_, k) => from + (size * (k + 1)) / (count + 1)), ref: from };
}

/** sp centres: a triple bond, or two double bonds (allenes, CO₂). */
function isLinear(mol: Molecule, id: number): boolean {
  const bonds = mol.bondsOf(id);
  return bonds.length === 2 && (bonds.some((b) => b.order === 3) || bonds.every((b) => b.order === 2));
}

/** The middle of the longest path: a balanced root for molecules without rings. */
function graphCenter(mol: Molecule, frag: number[]): number {
  const farthest = (start: number) => {
    const parent = new Map<number, number | null>([[start, null]]);
    const queue = [start];
    for (let i = 0; i < queue.length; i++) {
      for (const n of mol.neighbors(queue[i])) {
        if (!parent.has(n)) {
          parent.set(n, queue[i]);
          queue.push(n);
        }
      }
    }
    return { atom: queue[queue.length - 1], parent };
  };
  const a = farthest(frag[0]).atom;
  const { atom: b, parent } = farthest(a);
  const path: number[] = [];
  for (let x: number | null = b; x !== null; x = parent.get(x) ?? null) path.push(x);
  return path[Math.floor(path.length / 2)];
}

/**
 * Place a whole ring system so that atom `c` sits at `pc` with its outward
 * direction pointing back along the bond it hangs from; of the two mirror
 * images, keep the one that matches the drawing.
 */
function attachSystem(
  local: Pos,
  rings: Ring[],
  c: number,
  pc: Vec,
  d: number,
  v: number,
  pv: Vec,
  f: Frame,
  orig: (id: number) => Vec,
): Pos {
  const lc = local.get(c)!;
  const ringNeighbors = rings.flatMap((r) => {
    const k = r.atoms.indexOf(c);
    if (k < 0) return [];
    const n = r.atoms.length;
    return [r.atoms[(k + 1) % n], r.atoms[(k - 1 + n) % n]];
  });
  const centers = rings.filter((r) => r.atoms.includes(c)).map((r) => meanPoint(r.atoms.map((a) => local.get(a)!)));
  const outward = openDirections(
    lc,
    ringNeighbors.map((a) => local.get(a)!),
    centers,
    1,
  ).dirs[0];
  let best: { coords: Pos; err: number } | null = null;
  for (const reflect of [false, true]) {
    const rot = d + Math.PI - (reflect ? -outward : outward);
    const cs = Math.cos(rot);
    const sn = Math.sin(rot);
    const coords: Pos = new Map();
    let err = 0;
    for (const [id, p] of local) {
      const x = p.x - lc.x;
      const y = (p.y - lc.y) * (reflect ? -1 : 1);
      const q = { x: pc.x + cs * x - sn * y, y: pc.y + sn * x + cs * y };
      coords.set(id, q);
      const o = sub(orig(id), orig(v));
      const a = mapDir(f, angleOf(o));
      const r = Math.hypot(o.x, o.y);
      err += dist2(sub(q, pv), { x: Math.cos(a) * r, y: Math.sin(a) * r });
    }
    if (!best || err < best.err - 1e-9) best = { coords, err };
  }
  return best!.coords;
}

// ——— Ring systems ———

/** Rings grouped into fused, bridged or spiro systems (rings sharing any atom). */
function ringSystems(rings: Ring[]): Ring[][] {
  const parent = rings.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < rings.length; i++) {
    for (let j = i + 1; j < rings.length; j++) {
      if (rings[i].atoms.some((a) => rings[j].atoms.includes(a))) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, Ring[]>();
  rings.forEach((r, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), r]));
  return [...groups.values()];
}

/**
 * Lay a ring system out from regular polygons, ring by ring. Returns null for
 * systems that regular polygons can't express (bridged or overlapping rings).
 */
function constructRings(rings: Ring[], orig: (id: number) => Vec): Pos | null {
  const pos: Pos = new Map();
  const placed: Ring[] = [];
  const fused = (r: Ring) => rings.filter((s) => s !== r && r.atoms.filter((a) => s.atoms.includes(a)).length >= 2).length;
  const todo = [...rings].sort((x, y) => fused(y) - fused(x) || y.atoms.length - x.atoms.length);
  const first = todo.shift()!;
  regularPolygon({ x: 0, y: 0 }, first.atoms.length, -Math.PI / 2).forEach((p, k) => pos.set(first.atoms[k], p));
  placed.push(first);

  while (todo.length) {
    let pick = -1;
    let pickCount = 0;
    todo.forEach((r, i) => {
      const count = r.atoms.filter((a) => pos.has(a)).length;
      if (count > pickCount || (count === pickCount && count > 0 && r.atoms.length > todo[pick].atoms.length)) {
        pick = i;
        pickCount = count;
      }
    });
    if (pick < 0) return null;
    const ring = todo.splice(pick, 1)[0];
    const verts =
      pickCount === 1 ? spiroPolygon(ring, pos, placed, orig) : (fusedPolygon(ring, pos, placed) ?? completeRing(ring, pos, placed));
    if (!verts) return null;
    ring.atoms.forEach((a, k) => {
      if (!pos.has(a)) pos.set(a, verts[k]);
    });
    placed.push(ring);
  }
  return pos;
}

/** A ring fused onto atoms already placed: try each placed bond and side. */
function fusedPolygon(ring: Ring, pos: Pos, placed: Ring[]): Vec[] | null {
  const n = ring.atoms.length;
  let best: { verts: Vec[]; dev: number; clash: number } | null = null;
  for (let k = 0; k < n; k++) {
    const a = ring.atoms[k];
    const b = ring.atoms[(k + 1) % n];
    if (!pos.has(a) || !pos.has(b)) continue;
    for (const side of [1, -1]) {
      const poly = polygonOnBond(pos.get(a)!, pos.get(b)!, n, side);
      const verts = ring.atoms.map((_, i) => poly[(i - k + n) % n]);
      let dev = 0;
      ring.atoms.forEach((x, i) => {
        const p = pos.get(x);
        if (p) dev = Math.max(dev, dist(p, verts[i]));
      });
      let clash = 0;
      verts.forEach((q, i) => {
        if (pos.has(ring.atoms[i])) return;
        for (const p of pos.values()) if (dist(p, q) < 0.4) clash++;
      });
      const center = meanPoint(verts);
      for (const r of placed) if (pointInPolygon(center, r.atoms.map((x) => pos.get(x)!))) clash++;
      if (!best || clash < best.clash || (clash === best.clash && dev < best.dev)) best = { verts, dev, clash };
    }
  }
  if (!best || best.dev > 0.2 || best.clash > 0) return null;
  return best.verts;
}

/**
 * Finish a ring that can't be a regular polygon (peri-fused or bridged) when
 * its placed atoms form one unbroken path: the rest follow an arc of unit
 * bonds, or run straight across when every arc would hit other atoms. This
 * gives the usual drawings of acenaphthylene, norbornane (bridge inside the
 * hexagon) and bicyclo[2.2.2]octane (bridge through the middle).
 */
function completeRing(ring: Ring, pos: Pos, placed: Ring[]): Vec[] | null {
  const n = ring.atoms.length;
  const isPlaced = ring.atoms.map((a) => pos.has(a));
  const gaps = ring.atoms.map((_, i) => i).filter((i) => !isPlaced[i] && isPlaced[(i - 1 + n) % n]);
  if (gaps.length !== 1) return null;
  const free: number[] = [];
  for (let i = gaps[0]; !isPlaced[i % n]; i++) free.push(i % n);
  const m = free.length;
  const a = pos.get(ring.atoms[(gaps[0] - 1 + n) % n])!;
  const b = pos.get(ring.atoms[(gaps[0] + m) % n])!;
  const span = dist(a, b);

  const options: { pts: Vec[]; penalty: number }[] = [
    { pts: free.map((_, k) => add(a, scale(sub(b, a), (k + 1) / (m + 1)))), penalty: 0.3 },
  ];
  if (span > 1e-6 && span < m + 1 - 1e-6) {
    // Chord angle φ of m + 1 unit chords spanning the gap: sin((m+1)φ/2) / sin(φ/2) = span.
    let lo = 1e-9;
    let hi = TAU / (m + 1) - 1e-9;
    for (let it = 0; it < 60; it++) {
      const phi = (lo + hi) / 2;
      if (Math.sin(((m + 1) * phi) / 2) / Math.sin(phi / 2) > span) lo = phi;
      else hi = phi;
    }
    const phi = (lo + hi) / 2;
    for (const side of [1, -1]) {
      let dir = angleOf(sub(b, a)) + side * ((m * phi) / 2);
      let p = a;
      const pts: Vec[] = [];
      for (let k = 0; k < m; k++) {
        p = add(p, polar(dir));
        pts.push(p);
        dir -= side * phi;
      }
      options.push({ pts, penalty: 0 });
    }
  }

  const existing: [Vec, Vec][] = placed.flatMap((r) =>
    r.atoms.map((x, k) => [pos.get(x)!, pos.get(r.atoms[(k + 1) % r.atoms.length])!] as [Vec, Vec]),
  );
  let best: { pts: Vec[]; score: number } | null = null;
  for (const option of options) {
    let score = option.penalty;
    const chain = [a, ...option.pts, b];
    for (const q of option.pts) for (const p of pos.values()) if (dist(p, q) < 0.5) score += 1;
    for (let k = 1; k < chain.length; k++) {
      for (const [u, v] of existing) {
        const hit = segmentIntersection(chain[k - 1], chain[k], u, v);
        if (hit && hit.t > 1e-6 && hit.t < 1 - 1e-6 && hit.u > 1e-6 && hit.u < 1 - 1e-6) score += 0.5;
      }
    }
    if (!best || score < best.score - 1e-9) best = { pts: option.pts, score };
  }
  const verts = ring.atoms.map((x) => pos.get(x) ?? { x: 0, y: 0 });
  free.forEach((i, k) => (verts[i] = best!.pts[k]));
  return verts;
}

/** A spiro ring on one placed atom, pointing out of the roomiest gap. */
function spiroPolygon(ring: Ring, pos: Pos, placed: Ring[], orig: (id: number) => Vec): Vec[] {
  const n = ring.atoms.length;
  const k = ring.atoms.findIndex((a) => pos.has(a));
  const v = ring.atoms[k];
  const pv = pos.get(v)!;
  const neighbors: Vec[] = [];
  const centers: Vec[] = [];
  for (const r of placed) {
    const i = r.atoms.indexOf(v);
    if (i < 0) continue;
    const m = r.atoms.length;
    neighbors.push(pos.get(r.atoms[(i + 1) % m])!, pos.get(r.atoms[(i - 1 + m) % m])!);
    centers.push(meanPoint(r.atoms.map((a) => pos.get(a)!)));
  }
  const dir = openDirections(pv, neighbors, centers, 1).dirs[0];
  const poly = polygonAtVertex(pv, dir, n);
  const forward = ring.atoms.map((_, i) => poly[(i - k + n) % n]);
  const backward = ring.atoms.map((_, i) => poly[(k - i + n) % n]);
  // Of the two ways round, keep the one closer to the drawing.
  const ids = [...pos.keys()];
  const fit = fitRigid(ids.map(orig), ids.map((id) => pos.get(id)!), true);
  const err = (verts: Vec[]) => ring.atoms.reduce((s, a, i) => s + dist2(verts[i], applyRigid(fit, orig(a))), 0);
  return err(forward) <= err(backward) ? forward : backward;
}

/** Bridged systems: relax the drawn shape towards unit bonds and ring angles. */
function relaxedRings(mol: Molecule, rings: Ring[]): Pos {
  const atoms = [...new Set(rings.flatMap((r) => r.atoms))];
  const set = new Set(atoms);
  const lengths = [...mol.bonds.values()]
    .filter((b) => set.has(b.a) && set.has(b.b))
    .map((b) => dist(mol.pos(b.a), mol.pos(b.b)))
    .sort((a, b) => a - b);
  const median = lengths[lengths.length >> 1] || 1;
  const c = meanPoint(atoms.map((id) => mol.pos(id)));
  const start: Pos = new Map();
  atoms.forEach((id, i) => {
    const p = scale(sub(mol.pos(id), c), median > 1e-6 ? 1 / median : 1);
    // Separate atoms that were drawn on top of each other.
    const jitter = polar(i * 2.399, 0.05 * (1 + (i % 3)));
    start.set(id, add(p, jitter));
  });
  return relax(mol, atoms, start, rings, 'ideal', 600);
}

// ——— Untangling ———

/**
 * Mirror branches across single, acyclic bonds wherever that removes atoms
 * sitting on each other or bonds crossing, smallest branches first.
 */
function resolveClashes(mol: Molecule, frag: number[], pos: Pos, rings: Ring[], stereo: StereoTracker): void {
  const n = frag.length;
  const index = new Map(frag.map((id, i) => [id, i]));
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  frag.forEach((id, i) => {
    xs[i] = pos.get(id)!.x;
    ys[i] = pos.get(id)!.y;
  });
  const near = new Uint8Array(n * n);
  for (const id of frag) {
    const nb = mol.neighbors(id).map((x) => index.get(x)!);
    const i = index.get(id)!;
    for (const x of nb) {
      near[i * n + x] = near[x * n + i] = 1;
      for (const y of nb) near[x * n + y] = 1;
    }
  }
  const bonds = [...mol.bonds.values()].filter((b) => index.has(b.a)).map((b) => [index.get(b.a)!, index.get(b.b)!]);
  const ringBonds = new Set(rings.flatMap((r) => r.bonds));

  const overlap = (i: number, j: number) => {
    if (near[i * n + j]) return 0;
    const d = Math.hypot(xs[i] - xs[j], ys[i] - ys[j]);
    return d < 0.8 ? (0.8 - d) ** 2 * 10 : 0;
  };
  const crosses = (p: number[], q: number[]) => {
    if (p[0] === q[0] || p[0] === q[1] || p[1] === q[0] || p[1] === q[1]) return 0;
    const [ax, ay, bx, by] = [xs[p[0]], ys[p[0]], xs[p[1]], ys[p[1]]];
    const [cx, cy, dx, dy] = [xs[q[0]], ys[q[0]], xs[q[1]], ys[q[1]]];
    const side = (ux: number, uy: number, vx: number, vy: number, wx: number, wy: number) => (vx - ux) * (wy - uy) - (vy - uy) * (wx - ux);
    // Strictly crossing: bonds that merely touch shouldn't count.
    return side(ax, ay, bx, by, cx, cy) * side(ax, ay, bx, by, dx, dy) < -1e-9 &&
      side(cx, cy, dx, dy, ax, ay) * side(cx, cy, dx, dy, bx, by) < -1e-9
      ? 1
      : 0;
  };
  // Atoms only clash, and bonds only cross, when they are within a cell or so
  // of each other, so the static side of each flip is bucketed into a grid.
  const CELL = 1.5;
  const cell = (x: number, y: number) => Math.floor(x / CELL) * 1_000_003 + Math.floor(y / CELL);
  const bucket = <T,>(items: T[], at: (t: T) => [number, number]) => {
    const grid = new Map<number, T[]>();
    for (const t of items) {
      const [x, y] = at(t);
      const k = cell(x, y);
      const list = grid.get(k);
      if (list) list.push(t);
      else grid.set(k, [t]);
    }
    return grid;
  };
  const nearby = <T,>(grid: Map<number, T[]>, x: number, y: number, visit: (t: T) => void) => {
    const cx = Math.floor(x / CELL);
    const cy = Math.floor(y / CELL);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) grid.get((cx + dx) * 1_000_003 + cy + dy)?.forEach(visit);
  };
  const midX = (b: number[]) => (xs[b[0]] + xs[b[1]]) / 2;
  const midY = (b: number[]) => (ys[b[0]] + ys[b[1]]) / 2;
  /**
   * Clash score between the `moved` atoms and the rest; mirroring them leaves
   * every other pair unchanged. Only a bond that moves and one that stays can
   * change whether they cross.
   */
  const staticGrids = (moved: Uint8Array) => {
    const atoms: number[] = [];
    for (let i = 0; i < n; i++) if (!moved[i]) atoms.push(i);
    return {
      atoms: bucket(atoms, (i) => [xs[i], ys[i]]),
      bonds: bucket(
        bonds.filter((b) => !(moved[b[0]] && moved[b[1]])),
        (b) => [midX(b), midY(b)],
      ),
    };
  };
  const across = (moved: Uint8Array, grids: ReturnType<typeof staticGrids>) => {
    let s = 0;
    for (let i = 0; i < n; i++) if (moved[i]) nearby(grids.atoms, xs[i], ys[i], (j) => (s += overlap(i, j)));
    for (const p of bonds) {
      if (moved[p[0]] && moved[p[1]]) nearby(grids.bonds, midX(p), midY(p), (q) => (s += crosses(p, q)));
    }
    return s;
  };
  const fullScore = () => {
    let s = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) s += overlap(i, j);
    for (let i = 0; i < bonds.length; i++) for (let j = i + 1; j < bonds.length; j++) s += crosses(bonds[i], bonds[j]);
    return s;
  };
  let total = fullScore();
  if (total < 1e-9) return;

  const pivots: { axis: [number, number]; side: Uint8Array; ids: Set<number> }[] = [];
  for (const b of mol.bonds.values()) {
    if (!index.has(b.a) || b.order !== 1 || ringBonds.has(b.id)) continue;
    const reach = branch(mol, b.b, b.a);
    const ids = reach.size * 2 <= n ? reach : new Set(frag.filter((id) => !reach.has(id)));
    if (ids.size < 2) continue;
    const root = ids.has(b.b) ? b.b : b.a;
    const side = new Uint8Array(n);
    for (const id of ids) side[index.get(id)!] = 1;
    pivots.push({ axis: [index.get(root === b.b ? b.a : b.b)!, index.get(root)!], side, ids });
  }
  pivots.sort((x, y) => x.ids.size - y.ids.size);

  for (let pass = 0; pass < 4 && total > 1e-9; pass++) {
    let improved = false;
    for (const pivot of pivots) {
      const grids = staticGrids(pivot.side);
      const before = across(pivot.side, grids);
      const ax = xs[pivot.axis[0]];
      const ay = ys[pivot.axis[0]];
      const len = Math.hypot(xs[pivot.axis[1]] - ax, ys[pivot.axis[1]] - ay) || 1;
      const ux = (xs[pivot.axis[1]] - ax) / len;
      const uy = (ys[pivot.axis[1]] - ay) / len;
      const mirror = () => {
        for (let i = 0; i < n; i++) {
          if (!pivot.side[i]) continue;
          const t = (xs[i] - ax) * ux + (ys[i] - ay) * uy;
          xs[i] = 2 * (ax + ux * t) - xs[i];
          ys[i] = 2 * (ay + uy * t) - ys[i];
        }
      };
      mirror();
      const after = across(pivot.side, grids);
      if (after < before - 1e-6) {
        // A mirrored stereocentre would invert; swapping its wedges keeps it.
        stereo.flipCentres(pivot.ids);
        total += after - before;
        improved = true;
      } else mirror();
    }
    if (!improved) break;
  }
  frag.forEach((id, i) => pos.set(id, { x: xs[i], y: ys[i] }));

  // Whatever still overlaps gets nudged apart, keeping the shape where possible.
  if (fullScore() > 0.5) {
    const relaxed = relax(mol, frag, pos, rings, 'keep', 300);
    for (const id of frag) pos.set(id, relaxed.get(id)!);
  }
}

/** Atoms reachable from `start` without crossing back to `from`. */
function branch(mol: Molecule, start: number, from: number): Set<number> {
  const seen = new Set([start]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    for (const n of mol.neighbors(queue[i])) {
      if (seen.has(n) || (queue[i] === start && n === from)) continue;
      seen.add(n);
      queue.push(n);
    }
  }
  return seen;
}

// ——— Relaxation ———

/**
 * Position-based relaxation: bonds pulled to unit length, bond angles held
 * through 1–3 distances ('ideal' targets, or the current ones with 'keep'),
 * and atoms further apart pushed off each other.
 */
function relax(mol: Molecule, atoms: number[], start: Pos, rings: Ring[], mode: 'ideal' | 'keep', iterations: number): Pos {
  const n = atoms.length;
  const index = new Map(atoms.map((id, i) => [id, i]));
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  atoms.forEach((id, i) => {
    xs[i] = start.get(id)!.x;
    ys[i] = start.get(id)!.y;
  });
  const springs: { i: number; j: number; d: number; w: number }[] = [];
  const near = new Uint8Array(n * n);
  const mark = (i: number, j: number) => {
    near[i * n + j] = 1;
    near[j * n + i] = 1;
  };
  const current = (i: number, j: number) => Math.hypot(xs[j] - xs[i], ys[j] - ys[i]);

  for (const b of mol.bonds.values()) {
    const i = index.get(b.a);
    const j = index.get(b.b);
    if (i === undefined || j === undefined) continue;
    springs.push({ i, j, d: 1, w: 1 });
    mark(i, j);
  }
  for (const centre of atoms) {
    const nb = mol.neighbors(centre).filter((x) => index.has(x));
    for (let x = 0; x < nb.length; x++) {
      for (let y = x + 1; y < nb.length; y++) {
        const i = index.get(nb[x])!;
        const k = index.get(nb[y])!;
        mark(i, k);
        if (mode === 'keep') {
          springs.push({ i, j: k, d: current(i, k), w: 0.5 });
          continue;
        }
        const ring = rings
          .filter((r) => {
            const at = r.atoms.indexOf(centre);
            const m = r.atoms.length;
            if (at < 0) return false;
            const around = [r.atoms[(at + 1) % m], r.atoms[(at - 1 + m) % m]];
            return around.includes(nb[x]) && around.includes(nb[y]);
          })
          .sort((r1, r2) => r1.atoms.length - r2.atoms.length)[0];
        let theta: number | null = null;
        if (ring) theta = (Math.PI * (ring.atoms.length - 2)) / ring.atoms.length;
        else if (nb.length === 2) theta = isLinear(mol, centre) ? Math.PI : (2 * Math.PI) / 3;
        else if (nb.length === 3) theta = (2 * Math.PI) / 3;
        if (theta !== null) springs.push({ i, j: k, d: 2 * Math.sin(theta / 2), w: 0.4 });
      }
    }
  }
  if (mode === 'keep') {
    // Hold rings rigid while the rest gives way.
    for (const r of rings) {
      const idx = r.atoms.map((a) => index.get(a));
      if (idx.some((i) => i === undefined)) continue;
      for (let x = 0; x < idx.length; x++) {
        for (let y = x + 2; y < idx.length; y++) springs.push({ i: idx[x]!, j: idx[y]!, d: current(idx[x]!, idx[y]!), w: 0.6 });
      }
    }
  }

  const pull = (i: number, j: number, d: number, w: number) => {
    let dx = xs[j] - xs[i];
    let dy = ys[j] - ys[i];
    let l = Math.hypot(dx, dy);
    if (l < 1e-9) {
      dx = 1e-3;
      dy = 0;
      l = 1e-3;
    }
    const corr = ((l - d) / l) * 0.5 * w;
    xs[i] += dx * corr;
    ys[i] += dy * corr;
    xs[j] -= dx * corr;
    ys[j] -= dy * corr;
  };
  // Atoms only repel when closer than a bond, so pairs within 1.5 are listed
  // from a grid and the list refreshed every few iterations.
  let pairs: number[] = [];
  const listPairs = () => {
    pairs = [];
    const grid = new Map<number, number[]>();
    const key = (cx: number, cy: number) => cx * 1_000_003 + cy;
    for (let i = 0; i < n; i++) {
      const k = key(Math.floor(xs[i] / 1.5), Math.floor(ys[i] / 1.5));
      const list = grid.get(k);
      if (list) list.push(i);
      else grid.set(k, [i]);
    }
    for (let i = 0; i < n; i++) {
      const cx = Math.floor(xs[i] / 1.5);
      const cy = Math.floor(ys[i] / 1.5);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const j of grid.get(key(cx + dx, cy + dy)) ?? []) {
            if (j > i && !near[i * n + j] && current(i, j) < 1.5) pairs.push(i, j);
          }
        }
      }
    }
  };
  for (let it = 0; it < iterations; it++) {
    if (it % 10 === 0) listPairs();
    for (const sp of springs) pull(sp.i, sp.j, sp.d, sp.w);
    for (let k = 0; k < pairs.length; k += 2) {
      if (current(pairs[k], pairs[k + 1]) < 1) pull(pairs[k], pairs[k + 1], 1, 0.3);
    }
  }
  return new Map(atoms.map((id, i) => [id, { x: xs[i], y: ys[i] }]));
}

// ——— Placement on the page ———

interface Rigid {
  theta: number;
  reflect: boolean;
  from: Vec;
  to: Vec;
}

/** Least-squares rotation (optionally with a reflection) taking src onto dst. */
function fitRigid(src: Vec[], dst: Vec[], allowReflect: boolean): Rigid {
  const from = meanPoint(src);
  const to = meanPoint(dst);
  let best: (Rigid & { err: number }) | null = null;
  for (const reflect of allowReflect ? [false, true] : [false]) {
    let dotSum = 0;
    let crossSum = 0;
    for (let i = 0; i < src.length; i++) {
      const ax = src[i].x - from.x;
      const ay = (src[i].y - from.y) * (reflect ? -1 : 1);
      const bx = dst[i].x - to.x;
      const by = dst[i].y - to.y;
      dotSum += ax * bx + ay * by;
      crossSum += ax * by - ay * bx;
    }
    const t = { theta: Math.atan2(crossSum, dotSum), reflect, from, to };
    let err = 0;
    for (let i = 0; i < src.length; i++) err += dist2(applyRigid(t, src[i]), dst[i]);
    if (!best || err < best.err - 1e-9) best = { ...t, err };
  }
  return best!;
}

function applyRigid(t: Rigid, p: Vec): Vec {
  const x = p.x - t.from.x;
  const y = (p.y - t.from.y) * (t.reflect ? -1 : 1);
  const c = Math.cos(t.theta);
  const s = Math.sin(t.theta);
  return { x: t.to.x + c * x - s * y, y: t.to.y + s * x + c * y };
}

/** Turn the structure (by at most 15°) so its bonds sit on the 30° grid. */
function straighten(mol: Molecule, frag: number[], pos: Pos): void {
  let sx = 0;
  let sy = 0;
  for (const b of fragmentBonds(mol, frag)) {
    const a = angleOf(sub(pos.get(b.b)!, pos.get(b.a)!)) * 12;
    sx += Math.cos(a);
    sy += Math.sin(a);
  }
  if (sx * sx + sy * sy < 1e-12) return;
  const delta = -Math.atan2(sy, sx) / 12;
  const c = meanPoint(frag.map((id) => pos.get(id)!));
  const cs = Math.cos(delta);
  const sn = Math.sin(delta);
  for (const id of frag) {
    const p = sub(pos.get(id)!, c);
    pos.set(id, { x: c.x + cs * p.x - sn * p.y, y: c.y + sn * p.x + cs * p.y });
  }
}

/** Shift (by under a bond length) onto the hex lattice, if the bonds run along it. */
function snapToLattice(mol: Molecule, frag: number[], pos: Pos): void {
  const bonds = fragmentBonds(mol, frag);
  const along = bonds.filter((b) => {
    const k = (angleOf(sub(pos.get(b.b)!, pos.get(b.a)!)) - Math.PI / 6) / (Math.PI / 3);
    return Math.abs(k - Math.round(k)) < 0.01;
  }).length;
  if (!bonds.length || along < 0.8 * bonds.length) return;
  let best = { count: -1, shift: { x: 0, y: 0 } };
  for (const id of frag.slice(0, 24)) {
    const p = pos.get(id)!;
    const shift = sub(nearestLatticePoint(p), p);
    let count = 0;
    for (const x of frag) {
      const q = add(pos.get(x)!, shift);
      if (dist(nearestLatticePoint(q), q) < 0.02) count++;
    }
    if (count > best.count || (count === best.count && Math.hypot(shift.x, shift.y) < Math.hypot(best.shift.x, best.shift.y))) {
      best = { count, shift };
    }
  }
  for (const id of frag) pos.set(id, add(pos.get(id)!, best.shift));
}

const SQ3 = Math.sqrt(3);
const LATTICE_STEPS: Vec[] = [
  { x: SQ3, y: 0 },
  { x: -SQ3, y: 0 },
  { x: SQ3 / 2, y: 1.5 },
  { x: -SQ3 / 2, y: 1.5 },
  { x: SQ3 / 2, y: -1.5 },
  { x: -SQ3 / 2, y: -1.5 },
];

/** Move cleaned structures off any other structure they now overlap. */
function separate(mol: Molecule, all: number[][], cleaned: number[][], positions: Pos, lattice: boolean): void {
  const at = (id: number) => positions.get(id) ?? mol.pos(id);
  const fixed = all.filter((f) => !cleaned.includes(f)).flat();
  for (const frag of [...cleaned].sort((a, b) => b.length - a.length)) {
    for (let guard = 0; guard < 40; guard++) {
      const hits = fixed.filter((id) => frag.some((x) => dist(at(x), at(id)) < 1.2));
      if (!hits.length) break;
      let away = normalize(sub(meanPoint(frag.map(at)), meanPoint(hits.map(at))));
      if (away.x === 0 && away.y === 0) away = { x: 1, y: 0 };
      const step = lattice
        ? LATTICE_STEPS.reduce((best, s) => (dot(s, away) > dot(best, away) ? s : best))
        : scale(away, 1.5);
      for (const id of frag) positions.set(id, add(at(id), step));
    }
    fixed.push(...frag);
  }
}

function fragmentBonds(mol: Molecule, frag: number[]) {
  const set = new Set(frag);
  return [...mol.bonds.values()].filter((b) => set.has(b.a));
}

const dist2 = (a: Vec, b: Vec) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

/** Pending wedge/hash swaps, applied with the new positions. */
class StereoTracker {
  private readonly now = new Map<number, BondStereo>();

  constructor(private readonly mol: Molecule) {}

  /** Swap wedge and hash on every stereo bond whose stereocentre is in `centres`. */
  flipCentres(centres: Set<number>): void {
    for (const c of centres) {
      for (const b of this.mol.bondsOf(c)) {
        if (b.a !== c) continue;
        const s = this.now.get(b.id) ?? b.stereo;
        if (s === 'wedge') this.now.set(b.id, 'hash');
        else if (s === 'hash') this.now.set(b.id, 'wedge');
      }
    }
  }

  changes(): Map<number, BondStereo> {
    return new Map([...this.now].filter(([id, s]) => this.mol.bonds.get(id)!.stereo !== s));
  }
}
