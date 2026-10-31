import { add, boundsOf, dist, pointInPolygon, rotateAbout, type Box, type Vec } from './geometry';
import type { Molecule, MoleculeData } from './molecule';
import { nearestHexCenter } from './placement';

// A selection is a set of atom ids, picked with a box or lasso or a whole
// molecule at a time. A bond counts as selected when both its atoms are.

/** Atoms inside a closed polygon (a lasso, or a box given as its four corners). */
export function atomsInPolygon(mol: Molecule, poly: readonly Vec[]): number[] {
  const box = boundsOf(poly);
  if (!box || poly.length < 3) return [];
  const out: number[] = [];
  for (const a of mol.atoms.values()) {
    if (a.x < box.minX || a.x > box.maxX || a.y < box.minY || a.y > box.maxY) continue;
    if (pointInPolygon(a, poly)) out.push(a.id);
  }
  return out;
}

/** Bonds with both ends in the set. */
export function bondsWithin(mol: Molecule, atoms: ReadonlySet<number>): number[] {
  const out: number[] = [];
  for (const b of mol.bonds.values()) if (atoms.has(b.a) && atoms.has(b.b)) out.push(b.id);
  return out;
}

export function selectionBounds(mol: Molecule, atoms: Iterable<number>): Box | null {
  const pts: Vec[] = [];
  for (const id of atoms) {
    const a = mol.atoms.get(id);
    if (a) pts.push(a);
  }
  return boundsOf(pts);
}

export const boxCenter = (box: Box): Vec => ({ x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 });

/** Turn the atoms about `center` (default: the middle of their bounds). */
export function rotateAtoms(mol: Molecule, atoms: Iterable<number>, angle: number, center?: Vec): void {
  const ids = [...atoms].filter((id) => mol.atoms.has(id));
  const box = selectionBounds(mol, ids);
  if (!box) return;
  const c = center ?? boxCenter(box);
  for (const id of ids) mol.updateAtom(id, rotateAbout(mol.atoms.get(id)!, c, angle));
}

export type FlipAxis = 'horizontal' | 'vertical';

/**
 * Turn the atoms over, left to right or top to bottom, about the middle of
 * their bounds. Turning a molecule over takes its wedged bonds to the back,
 * so wedges and hashes swap at every stereocentre that turns over along with
 * all its neighbours: the drawing changes, the compound doesn't.
 */
export function flipAtoms(mol: Molecule, atoms: Iterable<number>, axis: FlipAxis): void {
  const ids = new Set([...atoms].filter((id) => mol.atoms.has(id)));
  const box = selectionBounds(mol, ids);
  if (!box) return;
  const c = boxCenter(box);
  for (const id of ids) {
    const a = mol.atoms.get(id)!;
    mol.updateAtom(id, axis === 'horizontal' ? { x: 2 * c.x - a.x } : { y: 2 * c.y - a.y });
  }
  for (const bond of mol.bonds.values()) {
    if (bond.stereo !== 'wedge' && bond.stereo !== 'hash') continue;
    if (!ids.has(bond.a) || !mol.neighbors(bond.a).every((n) => ids.has(n))) continue;
    mol.updateBond(bond.id, { stereo: bond.stereo === 'wedge' ? 'hash' : 'wedge' });
  }
}

/** The atoms and the bonds among them as standalone data, for copying. */
export function extractFragment(mol: Molecule, atoms: Iterable<number>): MoleculeData {
  const ids = new Set([...atoms].filter((id) => mol.atoms.has(id)));
  return {
    atoms: [...ids].map((id) => ({ ...mol.atoms.get(id)! })),
    bonds: bondsWithin(mol, ids).map((id) => ({ ...mol.bonds.get(id)! })),
    nextId: 0,
  };
}

/** Add a copy of `data`, shifted by `offset`. Returns the new atom ids. */
export function insertFragment(mol: Molecule, data: MoleculeData, offset: Vec = { x: 0, y: 0 }): number[] {
  const ids = new Map<number, number>();
  for (const a of data.atoms) ids.set(a.id, mol.addAtom(add(a, offset), a.element, a.charge).id);
  for (const b of data.bonds) {
    const a = ids.get(b.a);
    const c = ids.get(b.b);
    if (a !== undefined && c !== undefined) mol.addBond(a, c, b.order, b.stereo);
  }
  return [...ids.values()];
}

/**
 * The shift nearest `v` that maps the hex paper onto itself, so a copy of a
 * structure drawn on the lattice lands on it too.
 */
export const latticeShift = (v: Vec): Vec => nearestHexCenter(v);

/**
 * An offset for a copy of `data`, starting at `preferred` and stepping by
 * `step` until the copy no longer lands on anything already drawn.
 */
export function clearOffset(mol: Molecule, data: MoleculeData, preferred: Vec, step: Vec, clearance = 0.9): Vec {
  const others = [...mol.atoms.values()];
  const fits = (offset: Vec) => data.atoms.every((a) => others.every((o) => dist(add(a, offset), o) >= clearance));
  for (let k = 0; k < 40; k++) {
    const offset = { x: preferred.x + step.x * k, y: preferred.y + step.y * k };
    if (fits(offset)) return offset;
  }
  return preferred;
}
