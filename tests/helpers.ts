import { add, dist, lerp, polar, type Vec } from '../src/core/geometry';
import { Molecule } from '../src/core/molecule';
import { interpret, type StrokeInput } from '../src/gestures/interpret';
import { applyPlan, nearestAtom, type Plan } from '../src/gestures/plan';

/** Deterministic pseudo-random jitter so "hand-drawn" strokes are reproducible. */
export function rng(seed = 1): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
}

export function line(a: Vec, b: Vec, n = 30): Vec[] {
  return Array.from({ length: n + 1 }, (_, i) => lerp(a, b, i / n));
}

export function polyline(pts: Vec[], perSegment = 12): Vec[] {
  const out: Vec[] = [pts[0]];
  for (let k = 1; k < pts.length; k++) out.push(...line(pts[k - 1], pts[k], perSegment).slice(1));
  return out;
}

/** A wobbly hand-drawn circle; `sweep` > 2π overshoots past the start. */
export function circle(center: Vec, r: number, opts: { start?: number; sweep?: number; wobble?: number; seed?: number } = {}): Vec[] {
  const { start = -Math.PI / 2, sweep = Math.PI * 2.05, wobble = 0.04, seed = 7 } = opts;
  const rand = rng(seed);
  const n = 90;
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = start + (sweep * i) / n;
    return add(center, polar(t, r * (1 + wobble * rand())));
  });
}

/** A hand-drawn closed polygon, with a little jitter on every point. */
export function polygonStroke(center: Vec, r: number, sides: number, rotation = -Math.PI / 2, seed = 3): Vec[] {
  const corners = Array.from({ length: sides + 1 }, (_, k) => add(center, polar(rotation + (k * 2 * Math.PI) / sides, r)));
  const rand = rng(seed);
  return polyline(corners, 14).map((p) => ({ x: p.x + rand() * 0.04, y: p.y + rand() * 0.04 }));
}

export function scribble(center: Vec, width: number, passes: number): Vec[] {
  const pts: Vec[] = [];
  for (let k = 0; k <= passes; k++) {
    pts.push({ x: center.x + (k % 2 === 0 ? -width / 2 : width / 2), y: center.y + (k - passes / 2) * 0.08 });
  }
  return polyline(pts, 10);
}

/** Run a stroke through the interpreter and apply the result, like a pointer-up. */
export function draw(mol: Molecule, points: Vec[], opts: Partial<StrokeInput> = {}): Plan {
  const startAtom = opts.startAtom !== undefined ? opts.startAtom : nearestAtom(mol, points[0], 0.35);
  const endAtom = opts.endAtom !== undefined ? opts.endAtom : nearestAtom(mol, points[points.length - 1], 0.35);
  const plan = interpret(mol, { points, startAtom, endAtom, snap: opts.snap ?? false });
  applyPlan(mol, plan);
  return plan;
}

export function bondLengths(mol: Molecule): number[] {
  return [...mol.bonds.values()].map((b) => dist(mol.pos(b.a), mol.pos(b.b)));
}

/** Bond angles (degrees) at every atom with exactly two neighbours. */
export function chainAngles(mol: Molecule): number[] {
  const out: number[] = [];
  for (const atom of mol.atoms.values()) {
    const n = mol.neighbors(atom.id);
    if (n.length !== 2) continue;
    const p = mol.pos(atom.id);
    const a = mol.pos(n[0]);
    const b = mol.pos(n[1]);
    const v1 = { x: a.x - p.x, y: a.y - p.y };
    const v2 = { x: b.x - p.x, y: b.y - p.y };
    const cos = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y));
    out.push((Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI);
  }
  return out;
}

/**
 * Test-only SMILES reader (organic subset, branches, ring digits, = and #).
 * Every atom starts at the origin unless `place` positions it.
 */
export function fromSmiles(smiles: string, place: (k: number) => Vec = () => ({ x: 0, y: 0 })): Molecule {
  const mol = new Molecule();
  const stack: (number | null)[] = [];
  const open = new Map<string, { atom: number; order: number }>();
  let prev: number | null = null;
  let order = 1;
  let k = 0;
  for (let i = 0; i < smiles.length; ) {
    const ch = smiles[i];
    if (ch === '(') stack.push(prev);
    else if (ch === ')') prev = stack.pop() ?? null;
    else if (ch === '=') order = 2;
    else if (ch === '#') order = 3;
    else if (ch === '.') prev = null;
    else if (/\d/.test(ch)) {
      const ring = open.get(ch);
      if (ring) {
        mol.addBond(ring.atom, prev!, Math.max(order, ring.order) as 1 | 2 | 3);
        open.delete(ch);
      } else open.set(ch, { atom: prev!, order });
      order = 1;
    } else if (ch !== '-') {
      const two = smiles.slice(i, i + 2);
      const element = two === 'Cl' || two === 'Br' ? two : ch;
      const id = mol.addAtom(place(k++), element).id;
      if (prev !== null) mol.addBond(prev, id, order as 1 | 2 | 3);
      prev = id;
      order = 1;
      i += element.length;
      continue;
    }
    i++;
  }
  return mol;
}

/** Smallest distance between atoms more than two bonds apart. */
export function closestApproach(mol: Molecule): number {
  const atoms = [...mol.atoms.values()];
  let best = Infinity;
  for (let i = 0; i < atoms.length; i++) {
    const near = new Set([atoms[i].id, ...mol.neighbors(atoms[i].id).flatMap((n) => [n, ...mol.neighbors(n)])]);
    for (let j = i + 1; j < atoms.length; j++) {
      if (near.has(atoms[j].id)) continue;
      best = Math.min(best, dist(atoms[i], atoms[j]));
    }
  }
  return best;
}

/** Number of pairs of bonds (sharing no atom) that cross. */
export function bondCrossings(mol: Molecule): number {
  const bonds = [...mol.bonds.values()];
  let count = 0;
  for (let i = 0; i < bonds.length; i++) {
    for (let j = i + 1; j < bonds.length; j++) {
      const [p, q] = [bonds[i], bonds[j]];
      if (p.a === q.a || p.a === q.b || p.b === q.a || p.b === q.b) continue;
      const a = mol.pos(p.a), b = mol.pos(p.b), c = mol.pos(q.a), d = mol.pos(q.b);
      const cross = (u: Vec, v: Vec, w: Vec) => (v.x - u.x) * (w.y - u.y) - (v.y - u.y) * (w.x - u.x);
      if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) count++;
    }
  }
  return count;
}

/** All bond angles (degrees) around an atom, between neighbours adjacent in angle. */
export function anglesAround(mol: Molecule, id: number): number[] {
  const p = mol.pos(id);
  const a = mol
    .neighbors(id)
    .map((n) => Math.atan2(mol.pos(n).y - p.y, mol.pos(n).x - p.x))
    .sort((x, y) => x - y);
  return a.map((t, i) => {
    const next = i + 1 < a.length ? a[i + 1] : a[0] + 2 * Math.PI;
    return ((next - t) * 180) / Math.PI;
  });
}
