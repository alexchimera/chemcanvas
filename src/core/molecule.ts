import type { Vec } from './geometry';

export type BondOrder = 1 | 2 | 3;
export type BondStereo = 'none' | 'wedge' | 'hash' | 'wavy';

export interface Atom {
  id: number;
  x: number;
  y: number;
  element: string;
  charge: number;
}

export interface Bond {
  id: number;
  /** For wedge and hash bonds, `a` is the narrow end (the stereocentre). */
  a: number;
  b: number;
  order: BondOrder;
  stereo: BondStereo;
}

export interface MoleculeData {
  atoms: Atom[];
  bonds: Bond[];
  nextId: number;
}

/**
 * The structure being drawn: a graph of atoms (positions in model space) and
 * bonds. Hydrogens on heteroatoms and carbons are implicit; see chemistry.ts.
 */
export class Molecule {
  readonly atoms = new Map<number, Atom>();
  readonly bonds = new Map<number, Bond>();
  /** Bumped on every mutation so derived data (rings) can be cached against it. */
  version = 0;
  /**
   * Where ids for new atoms and bonds come from. A shared drawing swaps in a
   * source that can't hand out the same id as anyone else's.
   */
  idSource: (() => number) | null = null;
  private readonly adjacency = new Map<number, Set<number>>();
  private nextId = 1;

  get isEmpty(): boolean {
    return this.atoms.size === 0;
  }

  private newId(): number {
    return this.idSource ? this.idSource() : this.nextId++;
  }

  addAtom(pos: Vec, element = 'C', charge = 0): Atom {
    const atom: Atom = { id: this.newId(), x: pos.x, y: pos.y, element, charge };
    this.atoms.set(atom.id, atom);
    this.adjacency.set(atom.id, new Set());
    this.version++;
    return atom;
  }

  addBond(a: number, b: number, order: BondOrder = 1, stereo: BondStereo = 'none'): Bond | null {
    if (a === b || !this.atoms.has(a) || !this.atoms.has(b) || this.bondBetween(a, b)) return null;
    const bond: Bond = { id: this.newId(), a, b, order, stereo };
    this.bonds.set(bond.id, bond);
    this.adjacency.get(a)!.add(bond.id);
    this.adjacency.get(b)!.add(bond.id);
    this.version++;
    return bond;
  }

  removeBond(id: number): void {
    const bond = this.bonds.get(id);
    if (!bond) return;
    this.bonds.delete(id);
    this.adjacency.get(bond.a)?.delete(id);
    this.adjacency.get(bond.b)?.delete(id);
    this.version++;
  }

  removeAtom(id: number): void {
    const bonds = this.adjacency.get(id);
    if (!bonds) return;
    for (const bondId of [...bonds]) this.removeBond(bondId);
    this.atoms.delete(id);
    this.adjacency.delete(id);
    this.version++;
  }

  updateAtom(id: number, patch: Partial<Omit<Atom, 'id'>>): void {
    const atom = this.atoms.get(id);
    if (!atom) return;
    Object.assign(atom, patch);
    this.version++;
  }

  updateBond(id: number, patch: Partial<Pick<Bond, 'order' | 'stereo'>>): void {
    const bond = this.bonds.get(id);
    if (!bond) return;
    Object.assign(bond, patch);
    this.version++;
  }

  /** Add an atom with its id, or overwrite the atom that has it (keeping its bonds). */
  putAtom(atom: Atom): void {
    const existing = this.atoms.get(atom.id);
    if (existing) Object.assign(existing, atom);
    else {
      this.atoms.set(atom.id, { ...atom });
      this.adjacency.set(atom.id, new Set());
      this.nextId = Math.max(this.nextId, atom.id + 1);
    }
    this.version++;
  }

  /**
   * Add a bond with its id, or overwrite the bond that has it. Refused (false)
   * if an end is missing or a different bond already joins the same atoms.
   */
  putBond(bond: Bond): boolean {
    if (bond.a === bond.b || !this.atoms.has(bond.a) || !this.atoms.has(bond.b)) return false;
    const twin = this.bondBetween(bond.a, bond.b);
    if (twin && twin.id !== bond.id) return false;
    this.removeBond(bond.id);
    this.bonds.set(bond.id, { ...bond });
    this.adjacency.get(bond.a)!.add(bond.id);
    this.adjacency.get(bond.b)!.add(bond.id);
    this.nextId = Math.max(this.nextId, bond.id + 1);
    this.version++;
    return true;
  }

  /** Swap a bond's ends; flips which end of a wedge is narrow. */
  reverseBond(id: number): void {
    const bond = this.bonds.get(id);
    if (!bond) return;
    [bond.a, bond.b] = [bond.b, bond.a];
    this.version++;
  }

  pos(id: number): Vec {
    const atom = this.atoms.get(id)!;
    return { x: atom.x, y: atom.y };
  }

  bondBetween(a: number, b: number): Bond | undefined {
    const ids = this.adjacency.get(a);
    if (!ids) return undefined;
    for (const id of ids) {
      const bond = this.bonds.get(id)!;
      if (bond.a === b || bond.b === b) return bond;
    }
    return undefined;
  }

  bondsOf(id: number): Bond[] {
    return [...(this.adjacency.get(id) ?? [])].map((b) => this.bonds.get(b)!);
  }

  neighbors(id: number): number[] {
    return this.bondsOf(id).map((b) => (b.a === id ? b.b : b.a));
  }

  degree(id: number): number {
    return this.adjacency.get(id)?.size ?? 0;
  }

  /** Move every bond of `from` onto `into`, then delete `from`. */
  mergeAtom(from: number, into: number): void {
    if (from === into || !this.atoms.has(from) || !this.atoms.has(into)) return;
    for (const bond of this.bondsOf(from)) {
      const a = bond.a === from ? into : bond.a;
      const b = bond.b === from ? into : bond.b;
      this.removeBond(bond.id);
      this.addBond(a, b, bond.order, bond.stereo);
    }
    this.removeAtom(from);
  }

  /** Atom ids of the connected fragment containing `id`. */
  fragmentOf(id: number): number[] {
    const seen = new Set<number>([id]);
    const queue = [id];
    for (let i = 0; i < queue.length; i++) {
      for (const n of this.neighbors(queue[i])) {
        if (!seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    return queue;
  }

  components(): number[][] {
    const seen = new Set<number>();
    const out: number[][] = [];
    for (const id of this.atoms.keys()) {
      if (seen.has(id)) continue;
      const fragment = this.fragmentOf(id);
      fragment.forEach((a) => seen.add(a));
      out.push(fragment);
    }
    return out;
  }

  toJSON(): MoleculeData {
    return {
      atoms: [...this.atoms.values()].map((a) => ({ ...a })),
      bonds: [...this.bonds.values()].map((b) => ({ ...b })),
      nextId: this.nextId,
    };
  }

  /** Replace the contents in place (undo/redo keep the same instance). */
  load(data: MoleculeData): void {
    this.atoms.clear();
    this.bonds.clear();
    this.adjacency.clear();
    for (const a of data.atoms) {
      this.atoms.set(a.id, { ...a });
      this.adjacency.set(a.id, new Set());
    }
    for (const b of data.bonds) {
      if (!this.atoms.has(b.a) || !this.atoms.has(b.b)) continue;
      this.bonds.set(b.id, { ...b });
      this.adjacency.get(b.a)!.add(b.id);
      this.adjacency.get(b.b)!.add(b.id);
    }
    const maxId = Math.max(0, ...data.atoms.map((a) => a.id), ...data.bonds.map((b) => b.id));
    this.nextId = Math.max(data.nextId, maxId + 1);
    this.version++;
  }

  static fromJSON(data: MoleculeData): Molecule {
    const mol = new Molecule();
    mol.load(data);
    return mol;
  }

  clone(): Molecule {
    return Molecule.fromJSON(this.toJSON());
  }
}
