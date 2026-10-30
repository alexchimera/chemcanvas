import { add, dist, lerp, polar, type Vec } from '../src/core/geometry';
import type { Molecule } from '../src/core/molecule';
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
