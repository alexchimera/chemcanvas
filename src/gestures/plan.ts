import { dist, type Vec } from '../core/geometry';
import type { BondOrder, Molecule } from '../core/molecule';

/** A node in a build plan: an existing atom (`id`) or a new one at `pos`. */
export interface PlanNode {
  id?: number;
  pos: Vec;
}

export interface PlanEdge {
  i: number;
  j: number;
}

export interface BondChange {
  bond: number;
  order: BondOrder;
}

/**
 * What a gesture would do if released now. Plans are pure data: the canvas
 * previews them on a scratch copy of the molecule while the finger is down.
 */
export type Plan =
  | { kind: 'none' }
  | { kind: 'build'; nodes: PlanNode[]; edges: PlanEdge[]; increment?: number; label: string }
  | { kind: 'bond-orders'; changes: BondChange[]; label: string }
  | { kind: 'erase'; atoms: number[]; bonds: number[]; label: string };

export const NONE: Plan = { kind: 'none' };

/** Ids touched by applying a plan, for highlights and animation. */
export interface Applied {
  atoms: number[];
  bonds: number[];
}

/** Snap tolerance: a new atom this close to an existing one becomes that atom. */
export const MERGE_DISTANCE = 0.32;

export function nearestAtom(mol: Molecule, p: Vec, within: number, exclude?: (id: number) => boolean): number | null {
  let best: number | null = null;
  let bestD = within;
  for (const atom of mol.atoms.values()) {
    if (exclude?.(atom.id)) continue;
    const d = dist(p, atom);
    if (d < bestD) {
      bestD = d;
      best = atom.id;
    }
  }
  return best;
}

/** Collects nodes and edges, merging points that land on existing or earlier atoms. */
export class PlanBuilder {
  readonly nodes: PlanNode[] = [];
  readonly edges: PlanEdge[] = [];

  constructor(private readonly mol: Molecule) {}

  atom(id: number): number {
    const k = this.nodes.findIndex((n) => n.id === id);
    if (k >= 0) return k;
    this.nodes.push({ id, pos: this.mol.pos(id) });
    return this.nodes.length - 1;
  }

  point(pos: Vec): number {
    const hit = nearestAtom(this.mol, pos, MERGE_DISTANCE);
    if (hit !== null) return this.atom(hit);
    const k = this.nodes.findIndex((n) => n.id === undefined && dist(n.pos, pos) < MERGE_DISTANCE);
    if (k >= 0) return k;
    this.nodes.push({ pos });
    return this.nodes.length - 1;
  }

  edge(i: number, j: number): void {
    if (i === j) return;
    if (this.edges.some((e) => (e.i === i && e.j === j) || (e.i === j && e.j === i))) return;
    this.edges.push({ i, j });
  }

  /** Edges that would create a bond (rather than retrace an existing one). */
  newBondCount(): number {
    return this.edges.filter((e) => {
      const a = this.nodes[e.i].id;
      const b = this.nodes[e.j].id;
      return a === undefined || b === undefined || !this.mol.bondBetween(a, b);
    }).length;
  }

  build(label: string, increment?: number): Plan {
    return { kind: 'build', nodes: this.nodes, edges: this.edges, increment, label };
  }
}

/** Everything an erase removes: the hit atoms and bonds plus atoms left stranded. */
export function eraseClosure(
  mol: Molecule,
  atoms: readonly number[],
  bonds: readonly number[],
): { atoms: Set<number>; bonds: Set<number> } {
  const outAtoms = new Set(atoms.filter((id) => mol.atoms.has(id)));
  const outBonds = new Set(bonds.filter((id) => mol.bonds.has(id)));
  for (const id of outAtoms) for (const b of mol.bondsOf(id)) outBonds.add(b.id);
  const touched = new Set<number>();
  for (const id of outBonds) {
    const b = mol.bonds.get(id)!;
    touched.add(b.a);
    touched.add(b.b);
  }
  for (const id of touched) {
    if (outAtoms.has(id)) continue;
    if (mol.bondsOf(id).every((b) => outBonds.has(b.id))) outAtoms.add(id);
  }
  return { atoms: outAtoms, bonds: outBonds };
}

export function applyPlan(mol: Molecule, plan: Plan): Applied {
  switch (plan.kind) {
    case 'none':
      return { atoms: [], bonds: [] };
    case 'build': {
      const ids = plan.nodes.map((n) => n.id ?? mol.addAtom(n.pos).id);
      const atoms = ids.filter((_, k) => plan.nodes[k].id === undefined);
      const bonds: number[] = [];
      for (const e of plan.edges) {
        const a = ids[e.i];
        const b = ids[e.j];
        const existing = mol.bondBetween(a, b);
        if (existing) {
          if (plan.increment === existing.id && existing.order < 3) {
            mol.updateBond(existing.id, { order: (existing.order + 1) as BondOrder, stereo: 'none' });
            bonds.push(existing.id);
          }
          continue;
        }
        const bond = mol.addBond(a, b);
        if (bond) bonds.push(bond.id);
      }
      return { atoms, bonds };
    }
    case 'bond-orders': {
      for (const c of plan.changes) mol.updateBond(c.bond, { order: c.order, stereo: 'none' });
      return { atoms: [], bonds: plan.changes.map((c) => c.bond) };
    }
    case 'erase': {
      const doomed = eraseClosure(mol, plan.atoms, plan.bonds);
      for (const id of doomed.bonds) mol.removeBond(id);
      for (const id of doomed.atoms) mol.removeAtom(id);
      return { atoms: [], bonds: [] };
    }
  }
}
