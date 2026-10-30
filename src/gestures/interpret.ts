import { distToPolyline, midpoint, pathLength, resample, segmentIntersection, type Vec } from '../core/geometry';
import type { Molecule } from '../core/molecule';
import { planChain, type ChainInput, type ChainMemory } from './chain';
import { eraseClosure, NONE, type Plan } from './plan';
import { planRing } from './ring';
import { closedLoop, isScribble } from './stroke';

export type StrokeInput = ChainInput;
export type StrokeMemory = ChainMemory;

/**
 * Read a stroke (complete or still in progress) as a scribble to erase, a
 * closed loop to turn into a ring, or a path to turn into a bond chain.
 */
export function interpret(mol: Molecule, input: StrokeInput, memory: StrokeMemory = {}): Plan {
  const { points } = input;
  if (points.length < 2 || pathLength(points) < 0.3) return NONE;
  if (isScribble(points)) return erasePlan(mol, points);
  const loop = closedLoop(points);
  if (loop) return planRing(mol, loop, input.snap);
  return planChain(mol, input, memory);
}

export function erasePlan(mol: Molecule, points: readonly Vec[]): Plan {
  const pts = resample(points, 0.05);
  const atoms = [...mol.atoms.values()].filter((a) => distToPolyline(a, pts) <= 0.22).map((a) => a.id);
  const hit = new Set(atoms);
  const bonds: number[] = [];
  for (const bond of mol.bonds.values()) {
    if (hit.has(bond.a) || hit.has(bond.b)) continue;
    const a = mol.pos(bond.a);
    const b = mol.pos(bond.b);
    let crossings = 0;
    for (let i = 1; i < pts.length && crossings < 2; i++) if (segmentIntersection(a, b, pts[i - 1], pts[i])) crossings++;
    if (crossings >= 2 || distToPolyline(midpoint(a, b), pts) <= 0.25) bonds.push(bond.id);
  }
  const doomed = eraseClosure(mol, atoms, bonds);
  return { kind: 'erase', atoms, bonds, label: doomed.bonds.size || doomed.atoms.size ? 'erase' : 'nothing to erase' };
}
