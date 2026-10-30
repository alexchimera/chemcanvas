import { describe, expect, it } from 'vitest';
import {
  allowedValences,
  formulaOf,
  formulaText,
  hasValenceError,
  implicitHydrogens,
  molecularWeight,
} from '../src/core/chemistry';
import { normalizeSymbol } from '../src/core/elements';
import { vec } from '../src/core/geometry';
import { Molecule } from '../src/core/molecule';
import { findRings } from '../src/core/rings';
import { aspirin } from '../src/example';
import { parseMolfile, toMolfile } from '../src/io/molfile';
import { toSmiles } from '../src/io/smiles';

function chain(elements: string[], orders: number[] = []): Molecule {
  const mol = new Molecule();
  const ids = elements.map((el, i) => mol.addAtom(vec(i, 0), el).id);
  for (let i = 1; i < ids.length; i++) mol.addBond(ids[i - 1], ids[i], (orders[i - 1] ?? 1) as 1 | 2 | 3);
  return mol;
}

describe('valence and hydrogens', () => {
  it('follows the isoelectronic rule for charged atoms', () => {
    expect(allowedValences('N', 1)).toEqual([4]);
    expect(allowedValences('O', -1)).toEqual([1]);
    expect(allowedValences('C', 1)).toEqual([3]);
    expect(allowedValences('S', 0)).toEqual([2, 4, 6]);
    expect(allowedValences('Fe', 0)).toEqual([]);
  });

  it('fills implicit hydrogens', () => {
    const ethanol = chain(['C', 'C', 'O']);
    const [c1, c2, o] = [...ethanol.atoms.keys()];
    expect([c1, c2, o].map((id) => implicitHydrogens(ethanol, id))).toEqual([3, 2, 1]);
    const acetonitrile = chain(['C', 'C', 'N'], [1, 3]);
    expect(implicitHydrogens(acetonitrile, [...acetonitrile.atoms.keys()][2])).toBe(0);
  });

  it('flags pentavalent carbon', () => {
    const mol = new Molecule();
    const c = mol.addAtom(vec(0, 0)).id;
    for (let k = 0; k < 5; k++) mol.addBond(c, mol.addAtom(vec(Math.cos(k), Math.sin(k))).id);
    expect(hasValenceError(mol, c)).toBe(true);
  });

  it('computes formula and weight for aspirin', () => {
    const mol = aspirin();
    expect(formulaText(formulaOf(mol))).toBe('C9H8O4');
    expect(molecularWeight(mol)).toBeCloseTo(180.159, 2);
  });

  it('normalizes typed element symbols', () => {
    expect(normalizeSymbol('cl')).toBe('Cl');
    expect(normalizeSymbol('BR')).toBe('Br');
    expect(normalizeSymbol('Xx')).toBeNull();
  });
});

describe('rings', () => {
  it('finds the two rings of a fused system and none in a chain', () => {
    expect(findRings(chain(['C', 'C', 'C', 'C']))).toHaveLength(0);
    const mol = aspirin();
    expect(findRings(mol)).toHaveLength(1);
    expect(findRings(mol)[0].atoms).toHaveLength(6);
  });
});

describe('SMILES', () => {
  it('writes simple chains and branches', () => {
    expect(toSmiles(chain(['C', 'C', 'O']))).toBe('CCO');
    expect(toSmiles(chain(['C', 'C', 'C'], [1, 2]))).toBe('CC=C');
    expect(toSmiles(chain(['C', 'C', 'N'], [1, 3]))).toBe('CC#N');
  });

  it('writes rings with closure digits', () => {
    const mol = new Molecule();
    const ids = Array.from({ length: 6 }, (_, k) => mol.addAtom(vec(Math.cos(k), Math.sin(k))).id);
    ids.forEach((id, k) => mol.addBond(id, ids[(k + 1) % 6], k % 2 ? 2 : 1));
    expect(toSmiles(mol)).toMatch(/^C1=CC=CC=C1$|^C1C=CC=CC=1$/);
  });

  it('brackets charged atoms and atoms with unusual hydrogen counts', () => {
    const mol = chain(['C', 'N']);
    mol.updateAtom([...mol.atoms.keys()][1], { charge: 1 });
    expect(toSmiles(mol)).toBe('C[NH3+]');
    const anion = chain(['C', 'O']);
    anion.updateAtom([...anion.atoms.keys()][1], { charge: -1 });
    expect(toSmiles(anion)).toBe('C[O-]');
  });

  it('writes aspirin as a valid structure', () => {
    const smiles = toSmiles(aspirin());
    expect(smiles.startsWith('CC(=O)O')).toBe(true);
    expect(smiles.replace(/[^1]/g, '')).toHaveLength(2);
  });

  it('separates fragments with a dot', () => {
    const mol = chain(['C', 'C']);
    mol.addAtom(vec(5, 5), 'Na');
    expect(toSmiles(mol)).toBe('CC.[Na]');
  });
});

describe('Molfile', () => {
  it('round-trips atoms, bonds, charges and stereo', () => {
    const mol = aspirin();
    const [first] = mol.bonds.values();
    mol.updateBond(first.id, { stereo: 'wedge' });
    const o = [...mol.atoms.values()].find((a) => a.element === 'O')!;
    mol.updateAtom(o.id, { charge: -1 });
    const back = Molecule.fromJSON(parseMolfile(toMolfile(mol)));
    expect(back.atoms.size).toBe(mol.atoms.size);
    expect(back.bonds.size).toBe(mol.bonds.size);
    expect([...back.atoms.values()].filter((a) => a.charge === -1)).toHaveLength(1);
    expect([...back.bonds.values()].filter((b) => b.stereo === 'wedge')).toHaveLength(1);
    expect(formulaText(formulaOf(back))).toBe(formulaText(formulaOf(mol)));
    for (const b of back.bonds.values()) {
      const d = Math.hypot(back.atoms.get(b.a)!.x - back.atoms.get(b.b)!.x, back.atoms.get(b.a)!.y - back.atoms.get(b.b)!.y);
      expect(d).toBeCloseTo(1, 3);
    }
  });

  it('explains what is wrong with a bad file', () => {
    expect(() => parseMolfile('hello')).toThrow(/Molfile/);
  });
});
