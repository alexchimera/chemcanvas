import { atomicMass } from './elements';
import type { Molecule } from './molecule';

interface ValenceRule {
  /** Valence (outer-shell) electrons of the neutral atom. */
  electrons: number;
  /** Period 3+ elements may expand their octet in steps of two. */
  hyper?: boolean;
}

/**
 * Main-group elements that get implicit hydrogens. Everything else (metals,
 * noble gases) is drawn exactly as bonded, with no hydrogens added.
 */
const VALENCE: Record<string, ValenceRule> = {
  H: { electrons: 1 },
  B: { electrons: 3 },
  C: { electrons: 4 },
  N: { electrons: 5 },
  O: { electrons: 6 },
  F: { electrons: 7 },
  Si: { electrons: 4 },
  P: { electrons: 5, hyper: true },
  S: { electrons: 6, hyper: true },
  Cl: { electrons: 7 },
  Ge: { electrons: 4 },
  As: { electrons: 5, hyper: true },
  Se: { electrons: 6, hyper: true },
  Br: { electrons: 7 },
  Te: { electrons: 6, hyper: true },
  I: { electrons: 7, hyper: true },
};

/**
 * Allowed valences, using the isoelectronic rule for charges: N⁺ behaves like
 * C (4), O⁻ like F (1), C⁺ like B (3), and so on.
 */
export function allowedValences(element: string, charge: number): number[] {
  const rule = VALENCE[element];
  if (!rule) return [];
  if (element === 'H') return charge === 0 ? [1] : [0];
  const e = rule.electrons - charge;
  if (e <= 0 || e >= 8) return [0];
  const base = e <= 4 ? e : 8 - e;
  const out = [base];
  if (rule.hyper && e > 4) for (let v = base + 2; v <= e; v += 2) out.push(v);
  return out;
}

export function bondOrderSum(mol: Molecule, id: number): number {
  let sum = 0;
  for (const bond of mol.bondsOf(id)) sum += bond.order;
  return sum;
}

/** Hydrogens needed to bring the atom up to its next allowed valence. */
export function implicitHydrogens(mol: Molecule, id: number): number {
  const atom = mol.atoms.get(id);
  if (!atom) return 0;
  const used = bondOrderSum(mol, id);
  for (const v of allowedValences(atom.element, atom.charge)) if (v >= used) return v - used;
  return 0;
}

export function hasValenceError(mol: Molecule, id: number): boolean {
  const atom = mol.atoms.get(id);
  if (!atom) return false;
  const allowed = allowedValences(atom.element, atom.charge);
  return allowed.length > 0 && bondOrderSum(mol, id) > Math.max(...allowed);
}

export interface Formula {
  counts: Map<string, number>;
  charge: number;
}

/**
 * Formula of the whole drawing, or of some of its atoms. Hydrogens are counted
 * in context, so a selected methyl group off a ring reads CH3.
 */
export function formulaOf(mol: Molecule, atoms?: Iterable<number>): Formula {
  const counts = new Map<string, number>();
  let charge = 0;
  const bump = (el: string, n: number) => counts.set(el, (counts.get(el) ?? 0) + n);
  for (const id of atoms ?? mol.atoms.keys()) {
    const atom = mol.atoms.get(id);
    if (!atom) continue;
    bump(atom.element, 1);
    const h = implicitHydrogens(mol, atom.id);
    if (h) bump('H', h);
    charge += atom.charge;
  }
  return { counts, charge };
}

/** Hill order: C, then H, then alphabetical; without carbon, all alphabetical. */
export function hillOrder(counts: Map<string, number>): [string, number][] {
  const hasCarbon = (counts.get('C') ?? 0) > 0;
  const rank = (el: string) => (hasCarbon ? (el === 'C' ? 0 : el === 'H' ? 1 : 2) : 2);
  return [...counts.entries()]
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** "2+", "−", … as written after a formula or on an atom label. */
export function chargeText(charge: number): string {
  if (charge === 0) return '';
  const sign = charge > 0 ? '+' : '−';
  return Math.abs(charge) === 1 ? sign : `${Math.abs(charge)}${sign}`;
}

export function formulaText(formula: Formula): string {
  const body = hillOrder(formula.counts)
    .map(([el, n]) => (n === 1 ? el : `${el}${n}`))
    .join('');
  return body + chargeText(formula.charge);
}

/** Average molecular weight from standard atomic weights. */
export function formulaWeight(counts: Map<string, number>): number {
  let total = 0;
  for (const [el, n] of counts) total += atomicMass(el) * n;
  return total;
}

export function molecularWeight(mol: Molecule, atoms?: Iterable<number>): number {
  return formulaWeight(formulaOf(mol, atoms).counts);
}
