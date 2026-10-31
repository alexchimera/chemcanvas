import type { Atom, Bond, BondStereo, Molecule, MoleculeData } from './molecule';

/** One object's change: how it was and how it is now (null: not there). */
export interface Change<T> {
  id: number;
  before: T | null;
  after: T | null;
}

/**
 * An edit, object by object. Undo applies it backwards, and a shared drawing
 * sends it to everyone else, so it never mentions anything it didn't touch.
 */
export interface Patch {
  atoms: Change<Atom>[];
  bonds: Change<Bond>[];
}

export const emptyPatch = (): Patch => ({ atoms: [], bonds: [] });
export const isEmptyPatch = (p: Patch): boolean => p.atoms.length === 0 && p.bonds.length === 0;
export const invertPatch = (p: Patch): Patch => ({
  atoms: p.atoms.map((c) => ({ id: c.id, before: c.after, after: c.before })),
  bonds: p.bonds.map((c) => ({ id: c.id, before: c.after, after: c.before })),
});

const sameAtom = (a: Atom | null | undefined, b: Atom | null | undefined): boolean =>
  !a || !b ? !a && !b : a.x === b.x && a.y === b.y && a.element === b.element && a.charge === b.charge;
const sameBond = (a: Bond | null | undefined, b: Bond | null | undefined): boolean =>
  !a || !b ? !a && !b : a.a === b.a && a.b === b.b && a.order === b.order && a.stereo === b.stereo;

function changes<T extends { id: number }>(before: T[], after: T[], same: (a: T, b: T) => boolean): Change<T>[] {
  const was = new Map(before.map((o) => [o.id, o]));
  const out: Change<T>[] = [];
  for (const now of after) {
    const old = was.get(now.id);
    was.delete(now.id);
    if (!old || !same(old, now)) out.push({ id: now.id, before: old ? { ...old } : null, after: { ...now } });
  }
  for (const old of was.values()) out.push({ id: old.id, before: { ...old }, after: null });
  return out;
}

/** What changed between two states of a drawing. */
export function diffMolecules(before: MoleculeData, after: MoleculeData): Patch {
  return { atoms: changes(before.atoms, after.atoms, sameAtom), bonds: changes(before.bonds, after.bonds, sameBond) };
}

/**
 * Apply a patch and return the part that took. With `guard`, an object is
 * only changed if it is still as the patch found it, so undoing your own
 * edit never overwrites what someone else has done to it since.
 */
export function applyPatch(mol: Molecule, p: Patch, guard = false): Patch {
  const applied = emptyPatch();
  const atomOk = (c: Change<Atom>) => !guard || sameAtom(mol.atoms.get(c.id), c.before);
  const bondOk = (c: Change<Bond>) => !guard || sameBond(mol.bonds.get(c.id), c.before);
  // Bonds out first, then atoms in, atoms out (taking any other bonds with
  // them), and bonds in last, once both their ends exist.
  for (const c of p.bonds) {
    if (c.after || !bondOk(c)) continue;
    if (mol.bonds.has(c.id)) mol.removeBond(c.id);
    applied.bonds.push(c);
  }
  for (const c of p.atoms) {
    if (!c.after || !atomOk(c)) continue;
    mol.putAtom(c.after);
    applied.atoms.push(c);
  }
  for (const c of p.atoms) {
    if (c.after || !atomOk(c)) continue;
    if (mol.atoms.has(c.id)) mol.removeAtom(c.id);
    applied.atoms.push(c);
  }
  for (const c of p.bonds) {
    if (!c.after || !bondOk(c)) continue;
    if (mol.putBond(c.after)) applied.bonds.push(c);
  }
  return applied;
}

// ——— Checking patches that arrive over the network ———

const STEREO = new Set<BondStereo>(['none', 'wedge', 'hash', 'wavy']);
const isId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const isCoord = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e6;

function atomOf(v: unknown, id: number): Atom | null | undefined {
  if (v === null) return null;
  const a = v as Partial<Atom> | undefined;
  if (!a || a.id !== id || !isCoord(a.x) || !isCoord(a.y)) return undefined;
  if (typeof a.element !== 'string' || !/^[A-Z][a-z]{0,2}$/.test(a.element)) return undefined;
  if (!Number.isInteger(a.charge) || Math.abs(a.charge!) > 9) return undefined;
  return { id, x: a.x, y: a.y, element: a.element, charge: a.charge! };
}

function bondOf(v: unknown, id: number): Bond | null | undefined {
  if (v === null) return null;
  const b = v as Partial<Bond> | undefined;
  if (!b || b.id !== id || !isId(b.a) || !isId(b.b) || b.a === b.b) return undefined;
  if (b.order !== 1 && b.order !== 2 && b.order !== 3) return undefined;
  if (!b.stereo || !STEREO.has(b.stereo)) return undefined;
  return { id, a: b.a, b: b.b, order: b.order, stereo: b.stereo };
}

/** A well-formed copy of an untrusted patch, or null if any part of it is off. */
export function parsePatch(v: unknown, limit = 20000): Patch | null {
  const p = v as { atoms?: unknown; bonds?: unknown } | null;
  if (!p || !Array.isArray(p.atoms) || !Array.isArray(p.bonds) || p.atoms.length + p.bonds.length > limit) return null;
  const out = emptyPatch();
  for (const [list, read, into] of [
    [p.atoms, atomOf, out.atoms],
    [p.bonds, bondOf, out.bonds],
  ] as const) {
    for (const raw of list as unknown[]) {
      const c = raw as Partial<Change<unknown>> | null;
      if (!c || !isId(c.id)) return null;
      const before = read(c.before ?? null, c.id);
      const after = read(c.after ?? null, c.id);
      if (before === undefined || after === undefined) return null;
      (into as Change<unknown>[]).push({ id: c.id, before, after });
    }
  }
  return out;
}
