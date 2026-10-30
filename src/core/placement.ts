import {
  add,
  angleDiff,
  angleOf,
  deg,
  dist,
  midpoint,
  normalize,
  perp,
  polar,
  scale,
  sub,
  TAU,
  type Box,
  type Vec,
} from './geometry';
import type { Molecule } from './molecule';

/** The twelve 30° directions that skeletal formulas are normally drawn on. */
export const GRID_ANGLES = Array.from({ length: 12 }, (_, i) => (i * Math.PI) / 6);

/** Directions from an atom to each of its neighbours. */
export function neighborAngles(mol: Molecule, id: number): number[] {
  const p = mol.pos(id);
  return mol.neighbors(id).map((n) => angleOf(sub(mol.pos(n), p)));
}

/**
 * Directions in which a new bond would sit comfortably, best first: ±120°
 * from a single neighbour, otherwise the bisectors of the roomiest gaps.
 */
export function idealDirections(mol: Molecule, id: number): number[] {
  const angles = neighborAngles(mol, id);
  if (angles.length === 0) return [];
  if (angles.length === 1) return [angles[0] + (2 * Math.PI) / 3, angles[0] - (2 * Math.PI) / 3];
  const sorted = angles.map((a) => ((a % TAU) + TAU) % TAU).sort((a, b) => a - b);
  const gaps = sorted.map((from, i) => {
    const to = i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + TAU;
    return { mid: (from + to) / 2, size: to - from };
  });
  gaps.sort((a, b) => b.size - a.size);
  return gaps.filter((g, i) => i === 0 || g.size >= deg(100)).map((g) => g.mid);
}

/** The roomiest single direction around an atom (for charges, rings, labels). */
export function freeDirection(mol: Molecule, id: number): number {
  return idealDirections(mol, id)[0] ?? -Math.PI / 4;
}

/** Circumradius of a regular n-gon with unit sides. */
export const circumradius = (n: number): number => 1 / (2 * Math.sin(Math.PI / n));

/**
 * Default orientation (angle of vertex 0): a vertex on top for odd rings and
 * benzene-style hexagons, a flat top for 4- and 8-membered rings.
 */
export function standardRotation(n: number): number {
  return n % 2 === 0 && n !== 6 ? -Math.PI / 2 + Math.PI / n : -Math.PI / 2;
}

export function regularPolygon(center: Vec, n: number, rotation: number, side = 1): Vec[] {
  const r = circumradius(n) * side;
  return Array.from({ length: n }, (_, k) => add(center, polar(rotation + (k * TAU) / n, r)));
}

/** Regular n-gon sharing edge a→b, built on the given side (sign of cross(b − a, p − a)). */
export function polygonOnBond(a: Vec, b: Vec, n: number, side: number): Vec[] {
  const len = dist(a, b);
  const r = len / (2 * Math.sin(Math.PI / n));
  const apothem = len / (2 * Math.tan(Math.PI / n));
  let normal = perp(normalize(sub(b, a)));
  if (side < 0) normal = scale(normal, -1);
  const c = add(midpoint(a, b), scale(normal, apothem));
  const angA = angleOf(sub(a, c));
  const step = angleDiff(angleOf(sub(b, c)), angA);
  return Array.from({ length: n }, (_, k) => add(c, polar(angA + k * step, r)));
}

/** Regular n-gon with vertex 0 at `v` and its centre in direction `dir` from it. */
export function polygonAtVertex(v: Vec, dir: number, n: number): Vec[] {
  const r = circumradius(n);
  const c = add(v, polar(dir, r));
  return Array.from({ length: n }, (_, k) => add(c, polar(dir + Math.PI + (k * TAU) / n, r)));
}

// The canvas is "hex paper": a honeycomb lattice of pointy-top hexagons with
// unit sides. Horizontal zig-zag chains and upright benzene rings sit exactly
// on it, so separately drawn structures line up with each other.

const SQ3 = Math.sqrt(3);
const SUBLATTICE: Vec[] = [
  { x: 0, y: -1 },
  { x: SQ3 / 2, y: -0.5 },
];

export const hexCenter = (i: number, j: number): Vec => ({ x: SQ3 * (i + j / 2), y: 1.5 * j });

export function nearestHexCenter(p: Vec): Vec {
  const j0 = Math.round(p.y / 1.5);
  let best = hexCenter(0, 0);
  let bestD = Infinity;
  for (let j = j0 - 1; j <= j0 + 1; j++) {
    const i0 = Math.round(p.x / SQ3 - j / 2);
    for (let i = i0 - 1; i <= i0 + 1; i++) {
      const c = hexCenter(i, j);
      const d = dist(c, p);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
  }
  return best;
}

export function nearestLatticePoint(p: Vec, sublattice?: 0 | 1): Vec {
  const j0 = Math.round(p.y / 1.5);
  let best = p;
  let bestD = Infinity;
  for (let j = j0 - 2; j <= j0 + 2; j++) {
    const i0 = Math.round(p.x / SQ3 - j / 2);
    for (let i = i0 - 2; i <= i0 + 2; i++) {
      for (let s = 0; s < 2; s++) {
        if (sublattice !== undefined && s !== sublattice) continue;
        const v = add(hexCenter(i, j), SUBLATTICE[s]);
        const d = dist(v, p);
        if (d < bestD) {
          bestD = d;
          best = v;
        }
      }
    }
  }
  return best;
}

/**
 * Which sublattice a bond leaving in direction `theta` must start from to stay
 * on the lattice: 30°/150°/270° leave sublattice 0, 90°/210°/330° leave 1.
 */
export function sublatticeFor(theta: number): 0 | 1 | undefined {
  const k = Math.round(theta / deg(30));
  if (Math.abs(angleDiff(theta, k * deg(30))) > deg(1)) return undefined;
  const i = ((k % 12) + 12) % 12;
  if (i % 4 === 1) return 0;
  if (i % 4 === 3) return 1;
  return undefined;
}

export function forEachLatticePoint(box: Box, fn: (p: Vec) => void): void {
  const j0 = Math.floor(box.minY / 1.5) - 1;
  const j1 = Math.ceil(box.maxY / 1.5) + 1;
  for (let j = j0; j <= j1; j++) {
    const i0 = Math.floor(box.minX / SQ3 - j / 2) - 1;
    const i1 = Math.ceil(box.maxX / SQ3 - j / 2) + 1;
    for (let i = i0; i <= i1; i++) {
      const c = hexCenter(i, j);
      fn(add(c, SUBLATTICE[0]));
      fn(add(c, SUBLATTICE[1]));
    }
  }
}
