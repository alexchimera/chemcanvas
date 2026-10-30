import { bondOrderSum, implicitHydrogens } from '../core/chemistry';
import type { Bond, Molecule } from '../core/molecule';

/** Normal valences of the SMILES organic subset (atoms writable without brackets). */
const ORGANIC: Record<string, number[]> = {
  B: [3],
  C: [4],
  N: [3, 5],
  O: [2],
  P: [3, 5],
  S: [2, 4, 6],
  F: [1],
  Cl: [1],
  Br: [1],
  I: [1],
};

const BOND_SYMBOL: Record<number, string> = { 1: '', 2: '=', 3: '#' };

/** Hydrogens a SMILES reader would infer for an unbracketed atom, or null if it must be bracketed. */
function inferredHydrogens(element: string, valence: number): number | null {
  const normal = ORGANIC[element];
  if (!normal) return null;
  for (const v of normal) if (v >= valence) return v - valence;
  return 0;
}

function atomToken(mol: Molecule, id: number): string {
  const atom = mol.atoms.get(id)!;
  const h = implicitHydrogens(mol, id);
  if (atom.charge === 0 && inferredHydrogens(atom.element, bondOrderSum(mol, id)) === h) return atom.element;
  let token = `[${atom.element}`;
  if (h > 0) token += h > 1 ? `H${h}` : 'H';
  if (atom.charge !== 0) {
    const sign = atom.charge > 0 ? '+' : '-';
    token += Math.abs(atom.charge) > 1 ? `${sign}${Math.abs(atom.charge)}` : sign;
  }
  return `${token}]`;
}

/**
 * Write a (non-canonical) Kekulé SMILES string. Each fragment starts from a
 * terminal atom and follows its largest branch last, which keeps it readable.
 * Wedge and hash bonds are not encoded.
 */
export function toSmiles(mol: Molecule): string {
  return mol
    .components()
    .map((atoms) => fragmentSmiles(mol, atoms))
    .join('.');
}

function fragmentSmiles(mol: Molecule, atoms: number[]): string {
  const rank = (id: number) => {
    const d = mol.degree(id);
    return (d <= 1 ? d : 10 + d) + (mol.atoms.get(id)!.element === 'C' ? 0 : 0.5);
  };
  const start = [...atoms].sort((a, b) => rank(a) - rank(b) || a - b)[0];

  // Spanning tree by depth-first search; every other bond is a ring closure.
  const children = new Map<number, number[]>();
  const viaBond = new Map<number, Bond>();
  const closures: Bond[] = [];
  const seenClosure = new Set<number>();
  const visited = new Set<number>();
  const visit = (u: number, from: Bond | null) => {
    visited.add(u);
    children.set(u, []);
    // Lower-degree neighbours first: rings are walked through their unsubstituted
    // atoms, so substituents come last ("C1=CC=CC=C1C(=O)O" rather than "C1C(…)=CC=CC=1").
    const bonds = mol
      .bondsOf(u)
      .sort((x, y) => mol.degree(other(x, u)) - mol.degree(other(y, u)) || other(x, u) - other(y, u));
    for (const bond of bonds) {
      if (bond.id === from?.id) continue;
      const w = other(bond, u);
      if (visited.has(w)) {
        if (!seenClosure.has(bond.id)) {
          seenClosure.add(bond.id);
          closures.push(bond);
        }
        continue;
      }
      viaBond.set(w, bond);
      children.get(u)!.push(w);
      visit(w, bond);
    }
  };
  visit(start, null);

  const size = new Map<number, number>();
  const measure = (u: number): number => {
    let s = 1;
    for (const c of children.get(u)!) s += measure(c);
    size.set(u, s);
    return s;
  };
  measure(start);

  const emitted = new Set<number>();
  const open = new Map<number, number>();
  const free: number[] = [];
  let nextDigit = 1;
  const digitText = (d: number) => (d < 10 ? String(d) : `%${d}`);

  const emit = (u: number): string => {
    emitted.add(u);
    let out = atomToken(mol, u);
    const released: number[] = [];
    for (const bond of closures) {
      if (bond.a !== u && bond.b !== u) continue;
      const w = other(bond, u);
      const digit = open.get(bond.id);
      if (digit !== undefined && emitted.has(w)) {
        out += BOND_SYMBOL[bond.order] + digitText(digit);
        open.delete(bond.id);
        released.push(digit);
      } else if (!emitted.has(w)) {
        free.sort((a, b) => a - b);
        const d = free.shift() ?? nextDigit++;
        open.set(bond.id, d);
        out += digitText(d);
      }
    }
    free.push(...released);
    const kids = [...children.get(u)!].sort((a, b) => size.get(a)! - size.get(b)!);
    kids.forEach((k, i) => {
      const branch = BOND_SYMBOL[viaBond.get(k)!.order] + emit(k);
      out += i < kids.length - 1 ? `(${branch})` : branch;
    });
    return out;
  };
  return emit(start);
}

function other(bond: Bond, id: number): number {
  return bond.a === id ? bond.b : bond.a;
}
