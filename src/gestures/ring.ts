import { implicitHydrogens } from '../core/chemistry';
import {
  add,
  angleDiff,
  angleOf,
  centroid,
  cross,
  deg,
  dist,
  distToPolyline,
  meanPoint,
  pointInPolygon,
  polar,
  sub,
  type Vec,
} from '../core/geometry';
import type { Molecule } from '../core/molecule';
import {
  circumradius,
  idealDirections,
  nearestHexCenter,
  polygonAtVertex,
  polygonOnBond,
  regularPolygon,
  standardRotation,
} from '../core/placement';
import { findRings, ringPolygon, type Ring } from '../core/rings';
import { NONE, PlanBuilder, type Plan } from './plan';
import { estimateRingSize } from './stroke';

/**
 * Place a ring for a closed loop. In order of preference: toggle aromaticity
 * of a ring the loop sits inside, fuse onto a bond the loop runs along, grow
 * through an atom on the loop, hang off a nearby atom, or stand alone.
 */
export function planRing(mol: Molecule, loop: Vec[], snap: boolean): Plan {
  const center = centroid(loop);
  const loopRadius = loop.reduce((s, p) => s + dist(p, center), 0) / loop.length;

  const host = ringInsideLoop(mol, center, loopRadius);
  if (host) return aromatizePlan(mol, host);

  const { size, corners } = estimateRingSize(loop);
  const r = circumradius(size);
  const options: { score: number; make: () => Plan }[] = [];

  for (const bond of mol.bonds.values()) {
    const a = mol.pos(bond.a);
    const b = mol.pos(bond.b);
    const da = distToPolyline(a, loop, true);
    const db = distToPolyline(b, loop, true);
    if (da > 0.5 || db > 0.5) continue;
    const side = Math.sign(cross(sub(b, a), sub(center, a)));
    if (side === 0) continue;
    const verts = polygonOnBond(a, b, size, side);
    const off = dist(meanPoint(verts), center);
    if (off > 0.75 * r) continue;
    options.push({
      score: off + 0.5 * (da + db),
      make: () => ringPlan(mol, verts, [bond.a, bond.b], `fused ${size}-ring`),
    });
  }

  for (const atom of mol.atoms.values()) {
    const p = mol.pos(atom.id);
    const d = distToPolyline(p, loop, true);
    const toLoop = angleOf(sub(center, p));
    const degree = mol.degree(atom.id);
    if (d <= 0.45) {
      const dir = closestDirection(ringDirections(mol, atom.id, toLoop), toLoop);
      if (dir === null || Math.abs(angleDiff(dir, toLoop)) > deg(75)) continue;
      const verts = polygonAtVertex(p, dir, size);
      const off = dist(meanPoint(verts), center);
      if (off > 0.85 * r) continue;
      const label = degree >= 2 ? `spiro ${size}-ring` : `${size}-ring`;
      options.push({ score: off + d + 0.25, make: () => ringPlan(mol, verts, [atom.id], label) });
    } else if (d <= 1.3 && degree > 0 && !pointInPolygon(p, loop)) {
      const dir = closestDirection(idealDirections(mol, atom.id), toLoop);
      if (dir === null || Math.abs(angleDiff(dir, toLoop)) > deg(35)) continue;
      const verts = polygonAtVertex(add(p, polar(dir)), dir, size);
      const off = dist(meanPoint(verts), center);
      if (off > 0.7 * r) continue;
      options.push({ score: off + 0.45, make: () => ringPlan(mol, verts, [], `${size}-ring`, atom.id) });
    }
  }

  if (options.length) return options.sort((x, y) => x.score - y.score)[0].make();

  const rotation = freeRotation(size, corners, center);
  const c = snap && size === 6 && isPointyHexagon(rotation) ? nearestHexCenter(center) : center;
  return ringPlan(mol, regularPolygon(c, size, rotation), [], `${size}-ring`);
}

function ringPlan(mol: Molecule, verts: Vec[], fixed: number[], label: string, anchor?: number): Plan {
  const b = new PlanBuilder(mol);
  const ids = verts.map((p, k) => (k < fixed.length ? b.atom(fixed[k]) : b.point(p)));
  for (let k = 0; k < ids.length; k++) b.edge(ids[k], ids[(k + 1) % ids.length]);
  if (anchor !== undefined) b.edge(b.atom(anchor), ids[0]);
  return b.build(label);
}

/**
 * Where the centre of a ring through an existing atom should lie: straight on
 * from a chain end (so the chain bond bisects the ring's outer angle), or in
 * the roomiest gap for a spiro centre.
 */
function ringDirections(mol: Molecule, id: number, toLoop: number): number[] {
  const neighbors = mol.neighbors(id);
  if (neighbors.length === 0) return [toLoop];
  if (neighbors.length === 1) return [angleOf(sub(mol.pos(id), mol.pos(neighbors[0])))];
  return idealDirections(mol, id);
}

function closestDirection(dirs: number[], target: number): number | null {
  let best: number | null = null;
  for (const d of dirs) if (best === null || Math.abs(angleDiff(d, target)) < Math.abs(angleDiff(best, target))) best = d;
  return best;
}

/** Fit the rotation to the drawn corners, then snap to vertex-up or edge-up. */
function freeRotation(size: number, corners: Vec[] | null, center: Vec): number {
  const base = standardRotation(size);
  if (!corners || corners.length !== size) return base;
  let sx = 0;
  let sy = 0;
  for (const c of corners) {
    const a = angleOf(sub(c, center)) * size;
    sx += Math.cos(a);
    sy += Math.sin(a);
  }
  const fitted = Math.atan2(sy, sx) / size;
  const step = Math.PI / size;
  return base + Math.round((fitted - base) / step) * step;
}

function isPointyHexagon(rotation: number): boolean {
  const k = (rotation + Math.PI / 2) / (Math.PI / 3);
  return Math.abs(k - Math.round(k)) < 1e-6;
}

function ringInsideLoop(mol: Molecule, center: Vec, loopRadius: number): Ring | null {
  let best: Ring | null = null;
  let bestD = Infinity;
  for (const ring of findRings(mol)) {
    const poly = ringPolygon(mol, ring);
    if (!pointInPolygon(center, poly)) continue;
    const rc = meanPoint(poly);
    const rr = poly.reduce((s, p) => s + dist(p, rc), 0) / poly.length;
    const d = dist(center, rc);
    if (loopRadius > rr * 1.2 || d > rr * 0.5) continue;
    if (d < bestD) {
      bestD = d;
      best = ring;
    }
  }
  return best;
}

/**
 * Add alternating double bonds around a ring (a Kekulé structure), leaving
 * pyrrole-type heteroatoms alone; if none can be added, remove them instead.
 */
export function aromatizePlan(mol: Molecule, ring: Ring): Plan {
  const n = ring.bonds.length;
  const atomAt = (k: number) => ring.atoms[k % n];
  const open = (id: number) => !mol.bondsOf(id).some((b) => b.order >= 2) && implicitHydrogens(mol, id) >= 1;
  const usable = ring.bonds.map((_, k) => open(atomAt(k)) && open(atomAt(k + 1)));
  const hetero = (k: number) =>
    (mol.atoms.get(atomAt(k))!.element !== 'C' ? 1 : 0) + (mol.atoms.get(atomAt(k + 1))!.element !== 'C' ? 1 : 0);

  let chosen: number[] = [];
  if (n <= 12) {
    const full = (1 << n) - 1;
    let bestHetero = Infinity;
    for (let mask = 1; mask <= full; mask++) {
      if (mask & ((mask << 1) | (mask >>> (n - 1))) & full) continue;
      const picked: number[] = [];
      let het = 0;
      let ok = true;
      for (let k = 0; k < n && ok; k++) {
        if (!(mask & (1 << k))) continue;
        if (!usable[k]) ok = false;
        else {
          picked.push(k);
          het += hetero(k);
        }
      }
      if (!ok) continue;
      if (picked.length > chosen.length || (picked.length === chosen.length && het < bestHetero)) {
        chosen = picked;
        bestHetero = het;
      }
    }
  } else {
    for (let k = 0; k < n; k++) {
      const prev = chosen[chosen.length - 1];
      if (usable[k] && prev !== k - 1 && !(k === n - 1 && chosen[0] === 0)) chosen.push(k);
    }
  }

  if (chosen.length) {
    return {
      kind: 'bond-orders',
      changes: chosen.map((k) => ({ bond: ring.bonds[k], order: 2 })),
      label: 'aromatic',
    };
  }
  const doubles = ring.bonds.filter((id) => mol.bonds.get(id)!.order === 2);
  if (doubles.length) {
    return { kind: 'bond-orders', changes: doubles.map((bond) => ({ bond, order: 1 })), label: 'saturate' };
  }
  return NONE;
}
