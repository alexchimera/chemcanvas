import { meanPoint, pointInPolygon, type Vec } from './geometry';
import type { Bond, Molecule } from './molecule';

export interface Ring {
  /** Atom ids in order around the ring. */
  atoms: number[];
  /** Bond ids in the same order: bonds[k] joins atoms[k] and atoms[k + 1]. */
  bonds: number[];
}

const cache = new WeakMap<Molecule, { version: number; rings: Ring[] }>();

/** Smallest set of smallest rings, cached per molecule version. */
export function findRings(mol: Molecule): Ring[] {
  const hit = cache.get(mol);
  if (hit && hit.version === mol.version) return hit.rings;
  const rings = computeRings(mol);
  cache.set(mol, { version: mol.version, rings });
  return rings;
}

/**
 * Rings never cross a bridge (a bond whose removal disconnects the graph), so
 * the molecule is cut at its bridges and each ring block is searched alone.
 */
function computeRings(mol: Molecule): Ring[] {
  const cut = bridges(mol);
  const seen = new Set<number>();
  const rings: Ring[] = [];
  for (const start of mol.atoms.keys()) {
    if (seen.has(start)) continue;
    const atoms = [start];
    seen.add(start);
    const bonds = new Map<number, Bond>();
    for (let i = 0; i < atoms.length; i++) {
      for (const b of mol.bondsOf(atoms[i])) {
        if (cut.has(b.id)) continue;
        bonds.set(b.id, b);
        const w = b.a === atoms[i] ? b.b : b.a;
        if (!seen.has(w)) {
          seen.add(w);
          atoms.push(w);
        }
      }
    }
    if (bonds.size >= atoms.length) rings.push(...blockRings(mol, atoms, [...bonds.values()]));
  }
  return rings;
}

/** Bonds whose removal would split their molecule (Tarjan, iterative). */
function bridges(mol: Molecule): Set<number> {
  const disc = new Map<number, number>();
  const low = new Map<number, number>();
  const out = new Set<number>();
  let time = 0;
  for (const root of mol.atoms.keys()) {
    if (disc.has(root)) continue;
    disc.set(root, time);
    low.set(root, time++);
    const stack = [{ v: root, via: -1, bonds: mol.bondsOf(root), i: 0 }];
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top.i < top.bonds.length) {
        const b = top.bonds[top.i++];
        if (b.id === top.via) continue;
        const w = b.a === top.v ? b.b : b.a;
        if (!disc.has(w)) {
          disc.set(w, time);
          low.set(w, time++);
          stack.push({ v: w, via: b.id, bonds: mol.bondsOf(w), i: 0 });
        } else low.set(top.v, Math.min(low.get(top.v)!, disc.get(w)!));
        continue;
      }
      stack.pop();
      const parent = stack[stack.length - 1];
      if (!parent) continue;
      low.set(parent.v, Math.min(low.get(parent.v)!, low.get(top.v)!));
      if (low.get(top.v)! > disc.get(parent.v)!) out.add(top.via);
    }
  }
  return out;
}

/**
 * Horton's candidate cycles (for every root atom and every non-tree bond of
 * its BFS tree) sorted by size, then a greedy GF(2) elimination keeps the
 * first `E − V + 1` independent ones: a minimum cycle basis of the block.
 */
function blockRings(mol: Molecule, blockAtoms: number[], bonds: Bond[]): Ring[] {
  const cyclomatic = bonds.length - blockAtoms.length + 1;
  if (cyclomatic <= 0) return [];
  const inBlock = new Set(bonds.map((b) => b.id));

  const index = new Map(bonds.map((b, i) => [b.id, i]));
  const words = Math.ceil(bonds.length / 32);
  const seen = new Set<string>();
  const candidates: { bits: Uint32Array; bonds: number[] }[] = [];

  for (const root of blockAtoms) {
    const parentBond = new Map<number, number | null>([[root, null]]);
    const queue = [root];
    for (let i = 0; i < queue.length; i++) {
      const u = queue[i];
      for (const bond of mol.bondsOf(u)) {
        if (!inBlock.has(bond.id)) continue;
        const w = bond.a === u ? bond.b : bond.a;
        if (!parentBond.has(w)) {
          parentBond.set(w, bond.id);
          queue.push(w);
        }
      }
    }
    const pathToRoot = (from: number) => {
      const atoms: number[] = [];
      const via: number[] = [];
      let cur = from;
      while (cur !== root) {
        atoms.push(cur);
        const b = mol.bonds.get(parentBond.get(cur)!)!;
        via.push(b.id);
        cur = b.a === cur ? b.b : b.a;
      }
      return { atoms, via };
    };
    for (const bond of bonds) {
      if (!parentBond.has(bond.a) || !parentBond.has(bond.b)) continue;
      if (parentBond.get(bond.a) === bond.id || parentBond.get(bond.b) === bond.id) continue;
      const pa = pathToRoot(bond.a);
      const pb = pathToRoot(bond.b);
      const onA = new Set(pa.atoms);
      if (pb.atoms.some((a) => onA.has(a))) continue;
      const cycle = [...pa.via, ...pb.via, bond.id];
      const bits = new Uint32Array(words);
      for (const id of cycle) {
        const i = index.get(id)!;
        bits[i >>> 5] |= 1 << (i & 31);
      }
      const key = bits.join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ bits, bonds: cycle });
    }
  }

  candidates.sort((a, b) => a.bonds.length - b.bonds.length);
  const basis: { bits: Uint32Array; pivot: number }[] = [];
  const rings: Ring[] = [];
  for (const cand of candidates) {
    const v = cand.bits.slice();
    for (const b of basis) {
      if (v[b.pivot >>> 5] & (1 << (b.pivot & 31))) for (let w = 0; w < words; w++) v[w] ^= b.bits[w];
    }
    const pivot = firstSetBit(v);
    if (pivot < 0) continue;
    basis.push({ bits: v, pivot });
    rings.push(orderRing(mol, cand.bonds));
    if (rings.length === cyclomatic) break;
  }
  return rings;
}

function firstSetBit(bits: Uint32Array): number {
  for (let w = 0; w < bits.length; w++) {
    if (bits[w]) return w * 32 + (31 - Math.clz32(bits[w] & -bits[w]));
  }
  return -1;
}

function orderRing(mol: Molecule, bondIds: number[]): Ring {
  const next = new Map<number, number[]>();
  for (const id of bondIds) {
    const b = mol.bonds.get(id)!;
    next.set(b.a, [...(next.get(b.a) ?? []), b.b]);
    next.set(b.b, [...(next.get(b.b) ?? []), b.a]);
  }
  const start = mol.bonds.get(bondIds[0])!.a;
  const atoms = [start];
  let prev = -1;
  let cur = start;
  while (atoms.length < bondIds.length) {
    const step = next.get(cur)!.find((n) => n !== prev)!;
    prev = cur;
    cur = step;
    atoms.push(cur);
  }
  const bonds = atoms.map((a, k) => mol.bondBetween(a, atoms[(k + 1) % atoms.length])!.id);
  return { atoms, bonds };
}

export function ringPolygon(mol: Molecule, ring: Ring): Vec[] {
  return ring.atoms.map((id) => mol.pos(id));
}

export function ringCenter(mol: Molecule, ring: Ring): Vec {
  return meanPoint(ringPolygon(mol, ring));
}

/** The smallest ring whose outline contains the point. */
export function ringAt(mol: Molecule, p: Vec): Ring | null {
  let best: Ring | null = null;
  for (const ring of findRings(mol)) {
    if (pointInPolygon(p, ringPolygon(mol, ring)) && (!best || ring.atoms.length < best.atoms.length)) best = ring;
  }
  return best;
}
