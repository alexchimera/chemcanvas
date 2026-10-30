import { add, angleDiff, angleOf, deg, dist, distToPolyline, pathLength, polar, sub, type Vec } from '../core/geometry';
import type { Molecule } from '../core/molecule';
import { GRID_ANGLES, idealDirections, nearestLatticePoint, neighborAngles, sublatticeFor } from '../core/placement';
import { NONE, PlanBuilder, type Plan } from './plan';
import { StrokeTrack } from './stroke';

export interface ChainInput {
  /** Stroke points in model space, first point where the pointer went down. */
  points: Vec[];
  startAtom: number | null;
  /** Atom under the pointer's latest position. */
  endAtom: number | null;
  /** Snap chains started in empty space onto the hex lattice. */
  snap: boolean;
}

/** Kept across frames of one stroke so equally good fits don't flicker. */
export interface ChainMemory {
  firstDir?: number;
}

interface FirstStep {
  dir: number;
  pos: Vec;
  cost: number;
  /** Set when the step runs along an existing bond to this neighbour. */
  existing?: number;
}

const SIXTY = Math.PI / 3;

/** Turns available after each bond: ±60° keeps 120° bond angles; the rest are fallbacks. */
const TURNS = [
  { angle: SIXTY, turn: 1, cost: 0, fallback: false },
  { angle: -SIXTY, turn: -1, cost: 0, fallback: false },
  { angle: 0, turn: 0, cost: 0.5, fallback: true },
  { angle: Math.PI / 2, turn: 1, cost: 0.35, fallback: true },
  { angle: -Math.PI / 2, turn: -1, cost: 0.35, fallback: true },
];

/**
 * Turn a freehand stroke into a chain of unit bonds at standard angles. A
 * short flick is one bond; a long stroke becomes a zig-zag that follows the
 * path of the finger, connecting into any atoms it lands on.
 */
export function planChain(mol: Molecule, input: ChainInput, memory: ChainMemory): Plan {
  const { points, startAtom, endAtom } = input;
  if (points.length < 2) return NONE;

  // A short stroke from empty space onto an atom grows a substituent from that atom.
  if (startAtom === null && endAtom !== null && pathLength(points) < 1.6) {
    const reversed = { ...input, points: [...points].reverse(), startAtom: endAtom, endAtom: null };
    return planChain(mol, reversed, memory);
  }

  const startPos = startAtom !== null ? mol.pos(startAtom) : points[0];
  const track = new StrokeTrack(startAtom !== null ? [startPos, ...points] : points);
  if (track.total < 0.35) return NONE;

  // A straight stroke between two nearby atoms joins them, or raises the bond order.
  if (startAtom !== null && endAtom !== null && endAtom !== startAtom) {
    const span = dist(startPos, mol.pos(endAtom));
    if (span < 1.75 && track.total < span * 1.4 + 0.3) {
      const b = new PlanBuilder(mol);
      b.edge(b.atom(startAtom), b.atom(endAtom));
      const existing = mol.bondBetween(startAtom, endAtom);
      return b.build(existing ? orderLabel(existing.order + 1) : 'bond', existing?.id);
    }
  }

  const chosen = chooseChain(mol, track, startAtom, startPos, memory);
  if (!chosen) return NONE;
  memory.firstDir = chosen.first.dir;

  let positions = chosen.nodes;
  if (startAtom === null && input.snap) {
    const target = nearestLatticePoint(positions[0], sublatticeFor(chosen.first.dir));
    const delta = sub(target, positions[0]);
    positions = positions.map((p) => add(p, delta));
  }

  type Spec = { id: number } | { pos: Vec };
  const specs: Spec[] = positions.map((pos, k) => {
    if (k === 0 && startAtom !== null) return { id: startAtom };
    if (k === 1 && chosen.first.existing !== undefined) return { id: chosen.first.existing };
    return { pos };
  });
  if (endAtom !== null && endAtom !== startAtom) {
    const last = specs[specs.length - 1];
    if (!('id' in last && last.id === endAtom)) {
      const closeEnough = 'pos' in last && dist(last.pos, mol.pos(endAtom)) < 0.8;
      if (specs.length > 2 && closeEnough) specs[specs.length - 1] = { id: endAtom };
      else specs.push({ id: endAtom });
    }
  }

  const b = new PlanBuilder(mol);
  const ids = specs.map((s) => ('id' in s ? b.atom(s.id) : b.point(s.pos)));
  for (let k = 1; k < ids.length; k++) b.edge(ids[k - 1], ids[k]);

  // Retracing a single existing bond raises its order.
  if (b.edges.length === 1) {
    const [e] = b.edges;
    const x = b.nodes[e.i].id;
    const y = b.nodes[e.j].id;
    const existing = x !== undefined && y !== undefined ? mol.bondBetween(x, y) : undefined;
    if (existing) return b.build(orderLabel(existing.order + 1), existing.id);
  }
  const fresh = b.newBondCount();
  return b.build(fresh === 1 ? 'bond' : `chain · ${fresh}`);
}

function orderLabel(order: number): string {
  return order >= 3 ? 'triple bond' : 'double bond';
}

/**
 * Try every sensible first bond, walk the chain greedily, and keep the chain
 * whose shape best matches the stroke. Candidates are compared on the opening
 * stretch of the stroke only (that is what decides the first bond), so the
 * cost per frame stays flat however long the chain gets.
 */
function chooseChain(
  mol: Molecule,
  track: StrokeTrack,
  startAtom: number | null,
  startPos: Vec,
  memory: ChainMemory,
): { nodes: Vec[]; first: FirstStep } | null {
  const incoming =
    startAtom !== null && mol.degree(startAtom) === 1
      ? angleOf(sub(startPos, mol.pos(mol.neighbors(startAtom)[0])))
      : null;
  const head = track.prefix(4);
  const turnFor = (step: FirstStep) => (incoming === null ? 0 : Math.sign(angleDiff(step.dir, incoming)));
  let best: { first: FirstStep; err: number } | null = null;
  let kept: { first: FirstStep; err: number } | null = null;
  for (const step of firstSteps(mol, startAtom, startPos, track.total > 2.5)) {
    const { nodes, cost } = walk(head, startPos, step, turnFor(step));
    const err = chamfer(head, nodes) + step.cost + cost + 0.35 * dist(nodes[nodes.length - 1], head.end);
    const entry = { first: step, err };
    if (!best || err < best.err) best = entry;
    if (
      memory.firstDir !== undefined &&
      step.existing === undefined &&
      Math.abs(angleDiff(step.dir, memory.firstDir)) < 1e-6
    ) {
      kept = entry;
    }
  }
  const chosen = kept && best && kept.err < best.err + 0.05 ? kept : best;
  if (!chosen) return null;
  return { nodes: walk(track, startPos, chosen.first, turnFor(chosen.first)).nodes, first: chosen.first };
}

function firstSteps(mol: Molecule, startAtom: number | null, startPos: Vec, long: boolean): FirstStep[] {
  const steps: FirstStep[] = [];
  const taken = startAtom !== null ? neighborAngles(mol, startAtom) : [];
  const offer = (dir: number, base: number) => {
    let cost = base;
    if (taken.some((a) => Math.abs(angleDiff(a, dir)) < deg(45))) cost += 0.6;
    // Carrying straight on from a chain end is only right for alkynes and allenes.
    if (taken.length === 1 && Math.abs(angleDiff(taken[0], dir)) > deg(165)) cost += 0.3;
    const same = steps.find((s) => s.existing === undefined && Math.abs(angleDiff(s.dir, dir)) < deg(2));
    if (same) same.cost = Math.min(same.cost, cost);
    else steps.push({ dir, pos: add(startPos, polar(dir)), cost });
  };
  if (startAtom !== null) idealDirections(mol, startAtom).forEach((d, i) => offer(d, i === 0 ? 0 : 0.06));
  for (const g of GRID_ANGLES) offer(g, taken.length ? 0.12 : 0);
  // From empty space, 15° steps let a long chain run along an off-axis stroke
  // (bonds at 105°/165° zig-zag along 135°); the 30° grid is still preferred.
  if (long && taken.length === 0) for (const g of GRID_ANGLES) offer(g + Math.PI / 12, 0.06);
  if (startAtom !== null) {
    for (const n of mol.neighbors(startAtom)) {
      const pos = mol.pos(n);
      steps.push({ dir: angleOf(sub(pos, startPos)), pos, cost: 0.04, existing: n });
    }
  }
  return steps;
}

interface Step {
  pos: Vec;
  dir: number;
  turn: number;
  s: number;
  /** How well this bond fits the stroke (lower is better). */
  score: number;
  cost: number;
}

/** Score one candidate bond from `tip`, or null if it makes no progress along the stroke. */
function tryStep(track: StrokeTrack, tip: Vec, dir: number, turn: number, s: number, opt: (typeof TURNS)[number]): Step | null {
  const nextDir = dir + opt.angle;
  const pos = add(tip, polar(nextDir));
  const near = track.closest(pos, s, s + 2.5);
  if (near.s < s + 0.15) return null;
  // Prefer alternating turns (a zig-zag) when both turns fit equally well.
  const score = near.dist + opt.cost + (opt.turn !== 0 && opt.turn === turn ? 0.06 : 0);
  return { pos, dir: nextDir, turn: opt.turn, s: near.s, score, cost: opt.cost };
}

/**
 * Greedy walk: each bond turns ±60° toward wherever the stroke goes next,
 * looking one bond ahead so the zig-zag can swing back onto a drifting stroke.
 */
function walk(track: StrokeTrack, start: Vec, first: FirstStep, firstTurn: number): { nodes: Vec[]; cost: number } {
  const nodes = [start, first.pos];
  let cost = 0;
  const end = track.end;
  let tip = first.pos;
  let dir = first.dir;
  let turn = firstTurn;
  let s = track.closest(tip, 0, 2.5).s;
  const ahead = (step: Step) => {
    if (track.total - step.s < 0.45) return 0;
    let bestNext = Infinity;
    for (const opt of TURNS) {
      if (opt.fallback) continue;
      const next = tryStep(track, step.pos, step.dir, step.turn || turn, step.s, opt);
      if (next) bestNext = Math.min(bestNext, next.score);
    }
    return bestNext === Infinity ? 0.4 : bestNext;
  };
  for (let guard = 0; guard < 400; guard++) {
    const toEnd = dist(tip, end);
    if (toEnd < 0.45 || track.total - s < 0.45) break;
    let best: Step | null = null;
    let bestTotal = Infinity;
    for (const opt of TURNS) {
      if (opt.fallback && best !== null && best.score <= 0.7) continue;
      const step = tryStep(track, tip, dir, turn, s, opt);
      if (!step) continue;
      const total = step.score + 0.5 * ahead(step);
      if (total < bestTotal) {
        best = step;
        bestTotal = total;
      }
    }
    if (best === null) break;
    if (toEnd < 0.8 && dist(best.pos, end) > toEnd) break;
    nodes.push(best.pos);
    cost += best.cost;
    tip = best.pos;
    dir = best.dir;
    turn = best.turn || turn;
    s = best.s;
  }
  return { nodes, cost };
}

/** Symmetric mean distance between the stroke and the chain polyline. */
function chamfer(track: StrokeTrack, nodes: Vec[]): number {
  let there = 0;
  let count = 0;
  for (let i = 0; i < track.pts.length; i += 2) {
    there += distToPolyline(track.pts[i], nodes);
    count++;
  }
  let back = 0;
  for (let k = 1; k < nodes.length; k++) back += track.distanceTo(nodes[k]);
  return there / count + back / (nodes.length - 1);
}
