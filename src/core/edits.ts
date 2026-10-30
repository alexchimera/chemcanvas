import type { Vec } from './geometry';
import type { BondOrder, Molecule } from './molecule';

export type BondStyle = 'single' | 'double' | 'triple' | 'wedge' | 'hash' | 'wavy';

/** Tap on a bond: single → double → triple → single. */
export function cycleBondOrder(mol: Molecule, id: number): void {
  const bond = mol.bonds.get(id);
  if (!bond) return;
  const order = (bond.stereo !== 'none' ? 1 : (bond.order % 3) + 1) as BondOrder;
  mol.updateBond(id, { order, stereo: 'none' });
}

export function setBondStyle(mol: Molecule, id: number, style: BondStyle): void {
  const bond = mol.bonds.get(id);
  if (!bond) return;
  if (style === 'single' || style === 'double' || style === 'triple') {
    mol.updateBond(id, { order: style === 'single' ? 1 : style === 'double' ? 2 : 3, stereo: 'none' });
    return;
  }
  if (bond.stereo === style && style !== 'wavy') {
    // Choosing the same wedge again flips which end is the stereocentre.
    mol.reverseBond(id);
    return;
  }
  // Put the narrow end on the atom more likely to be the stereocentre.
  if (style !== 'wavy' && mol.degree(bond.b) > mol.degree(bond.a)) mol.reverseBond(id);
  mol.updateBond(id, { order: 1, stereo: style });
}

export function setElement(mol: Molecule, id: number, element: string): void {
  const atom = mol.atoms.get(id);
  if (!atom || atom.element === element) return;
  mol.updateAtom(id, { element, charge: 0 });
}

export function adjustCharge(mol: Molecule, id: number, delta: number): void {
  const atom = mol.atoms.get(id);
  if (!atom) return;
  const charge = Math.max(-4, Math.min(4, atom.charge + delta));
  if (charge !== atom.charge) mol.updateAtom(id, { charge });
}

/** Delete an atom along with any neighbours that would be left on their own. */
export function deleteAtom(mol: Molecule, id: number): void {
  const neighbors = mol.neighbors(id);
  mol.removeAtom(id);
  for (const n of neighbors) if (mol.degree(n) === 0) mol.removeAtom(n);
}

export function deleteBond(mol: Molecule, id: number): void {
  const bond = mol.bonds.get(id);
  if (!bond) return;
  mol.removeBond(id);
  for (const n of [bond.a, bond.b]) if (mol.degree(n) === 0) mol.removeAtom(n);
}

export function addLoneAtom(mol: Molecule, pos: Vec, element = 'C'): number {
  return mol.addAtom(pos, element).id;
}

/** Move a set of atoms by an offset. */
export function translateAtoms(mol: Molecule, ids: Iterable<number>, delta: Vec): void {
  for (const id of ids) {
    const atom = mol.atoms.get(id);
    if (atom) mol.updateAtom(id, { x: atom.x + delta.x, y: atom.y + delta.y });
  }
}
