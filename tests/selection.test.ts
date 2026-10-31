import { describe, expect, it } from 'vitest';
import { analysisText, analyze } from '../src/core/analysis';
import { formulaOf, formulaText } from '../src/core/chemistry';
import { add, dist, polar } from '../src/core/geometry';
import { Molecule } from '../src/core/molecule';
import { nearestLatticePoint } from '../src/core/placement';
import {
  atomsInPolygon,
  bondsWithin,
  clearOffset,
  extractFragment,
  flipAtoms,
  insertFragment,
  latticeShift,
  rotateAtoms,
  selectionBounds,
} from '../src/core/selection';
import { aspirin } from '../src/example';
import { toSmiles } from '../src/io/smiles';
import { bondLengths, fromSmiles, rng } from './helpers';

const h = Math.sqrt(3) / 2;

/** 2-Butanol with its OH wedged: the stereocentre is atom `centre`. */
function butanol() {
  const mol = new Molecule();
  const centre = mol.addAtom({ x: 0, y: 0 }).id;
  const methyl = mol.addAtom({ x: -h, y: 0.5 }).id;
  const ethyl = mol.addAtom({ x: h, y: 0.5 }).id;
  const ethyl2 = mol.addAtom({ x: 2 * h, y: 0 }).id;
  const oxygen = mol.addAtom({ x: 0, y: -1 }, 'O').id;
  mol.addBond(centre, methyl);
  mol.addBond(centre, ethyl);
  mol.addBond(ethyl, ethyl2);
  const wedge = mol.addBond(centre, oxygen, 1, 'wedge')!.id;
  return { mol, centre, methyl, ethyl, ethyl2, oxygen, wedge };
}

/**
 * Handedness of a stereocentre from the drawing: neighbours (in id order) as
 * 3D vectors, wedged ends up out of the page, hashed ends into it.
 */
function handedness(mol: Molecule, centre: number): number {
  const p = mol.pos(centre);
  const [a, b, c] = mol
    .neighbors(centre)
    .sort((x, y) => x - y)
    .map((n) => {
      const bond = mol.bondBetween(centre, n)!;
      const z = bond.a !== centre ? 0 : bond.stereo === 'wedge' ? 1 : bond.stereo === 'hash' ? -1 : 0;
      const q = mol.pos(n);
      return [q.x - p.x, q.y - p.y, z];
    });
  return Math.sign(a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]));
}

describe('picking atoms', () => {
  it('a lasso around the ring picks its six atoms', () => {
    const mol = aspirin();
    const lasso = Array.from({ length: 24 }, (_, k) => polar((k / 24) * 2 * Math.PI, 1.3));
    const picked = atomsInPolygon(mol, lasso);
    expect(picked).toHaveLength(6);
    expect(bondsWithin(mol, new Set(picked))).toHaveLength(6);
  });

  it('a box picks what is inside it and nothing else', () => {
    const mol = aspirin();
    // The acid group sits above the ring, y < −1.5.
    const box = [
      { x: -2, y: -3 },
      { x: 2, y: -3 },
      { x: 2, y: -1.5 },
      { x: -2, y: -1.5 },
    ];
    const picked = atomsInPolygon(mol, box);
    expect(formulaText(formulaOf(mol, picked))).toBe('CHO2');
  });

  it('bounds cover the picked atoms', () => {
    const mol = aspirin();
    const box = selectionBounds(mol, mol.atoms.keys())!;
    expect(box.minY).toBeCloseTo(-2.5);
    expect(box.maxY).toBeCloseTo(1);
    expect(selectionBounds(mol, [])).toBeNull();
  });
});

describe('moving selections', () => {
  it('rotating keeps bond lengths and stereochemistry', () => {
    const { mol, centre } = butanol();
    const before = handedness(mol, centre);
    rotateAtoms(mol, mol.atoms.keys(), Math.PI / 2);
    for (const len of bondLengths(mol)) expect(len).toBeCloseTo(1, 9);
    expect(handedness(mol, centre)).toBe(before);
  });

  it('rotates about the middle of the selection', () => {
    const mol = aspirin();
    const ring = atomsInPolygon(mol, Array.from({ length: 12 }, (_, k) => polar((k / 12) * 2 * Math.PI, 1.3)));
    const box = selectionBounds(mol, ring)!;
    rotateAtoms(mol, ring, Math.PI / 3);
    const after = selectionBounds(mol, ring)!;
    expect((after.minX + after.maxX) / 2).toBeCloseTo((box.minX + box.maxX) / 2, 6);
  });

  it('flipping a molecule over swaps wedges for hashes and keeps its configuration', () => {
    const { mol, centre, wedge, methyl, ethyl } = butanol();
    const before = handedness(mol, centre);
    const x = { methyl: mol.pos(methyl).x, ethyl: mol.pos(ethyl).x };
    flipAtoms(mol, mol.atoms.keys(), 'horizontal');
    expect(mol.bonds.get(wedge)!.stereo).toBe('hash');
    expect(handedness(mol, centre)).toBe(before);
    // Left and right have swapped round.
    expect(mol.pos(methyl).x).toBeGreaterThan(mol.pos(ethyl).x);
    expect(x.methyl).toBeLessThan(x.ethyl);

    flipAtoms(mol, mol.atoms.keys(), 'vertical');
    expect(mol.bonds.get(wedge)!.stereo).toBe('wedge');
    expect(handedness(mol, centre)).toBe(before);
  });

  it('flipping twice puts every atom back', () => {
    const mol = aspirin();
    const before = mol.toJSON();
    flipAtoms(mol, mol.atoms.keys(), 'vertical');
    flipAtoms(mol, mol.atoms.keys(), 'vertical');
    for (const a of before.atoms) {
      expect(mol.atoms.get(a.id)!.x).toBeCloseTo(a.x, 9);
      expect(mol.atoms.get(a.id)!.y).toBeCloseTo(a.y, 9);
    }
  });

  it('leaves the wedge alone when part of the stereocentre stays behind', () => {
    const { mol, centre, methyl, oxygen, wedge } = butanol();
    flipAtoms(mol, [centre, methyl, oxygen], 'horizontal');
    expect(mol.bonds.get(wedge)!.stereo).toBe('wedge');
  });
});

describe('copying', () => {
  it('a copy is a separate molecule with the same structure', () => {
    const mol = aspirin();
    const data = extractFragment(mol, mol.atoms.keys());
    const ids = insertFragment(mol, data, { x: 10, y: 0 });
    expect(ids).toHaveLength(13);
    expect(ids.every((id) => !data.atoms.some((a) => a.id === id))).toBe(true);
    const [first, second] = toSmiles(mol).split('.');
    expect(second).toBe(first);
    expect(mol.pos(ids[0]).x - data.atoms[0].x).toBeCloseTo(10);
  });

  it('copies only the bonds inside the selection, with their stereo', () => {
    const { mol, centre, oxygen, methyl } = butanol();
    const data = extractFragment(mol, [centre, oxygen, methyl]);
    expect(data.atoms).toHaveLength(3);
    expect(data.bonds).toHaveLength(2);
    expect(data.bonds.find((b) => b.stereo === 'wedge')).toBeDefined();
  });

  it('lattice shifts keep structures on the hex paper', () => {
    const rand = rng(11);
    const p = nearestLatticePoint({ x: 0.3, y: 0.2 });
    for (let k = 0; k < 20; k++) {
      const q = add(p, latticeShift({ x: rand() * 20, y: rand() * 20 }));
      expect(dist(nearestLatticePoint(q), q)).toBeLessThan(1e-9);
    }
  });

  it('finds a clear spot for a copy', () => {
    const mol = aspirin();
    const data = extractFragment(mol, mol.atoms.keys());
    const offset = clearOffset(mol, data, { x: 0, y: 0 }, { x: Math.sqrt(3), y: 0 });
    expect(offset.x).toBeGreaterThan(2);
    for (const a of data.atoms) {
      for (const b of mol.atoms.values()) expect(dist(add(a, offset), b)).toBeGreaterThanOrEqual(0.9);
    }
  });
});

describe('analysis', () => {
  it('matches the reference values for aspirin', () => {
    const a = analyze(aspirin());
    expect(a.formulaText).toBe('C9H8O4');
    expect(a.exactMass).toBeCloseTo(180.0423, 4);
    expect(a.weight).toBeCloseTo(180.16, 2);
    expect(a.composition.map((c) => `${c.element}, ${c.percent.toFixed(2)}`).join('; ')).toBe('C, 60.00; H, 4.48; O, 35.52');
    expect(a.peaks).toHaveLength(3);
    expect(a.peaks[0].mz).toBeCloseTo(180.0423, 4);
    expect(a.peaks[0].relative).toBe(100);
    expect(a.peaks[1].mz).toBeCloseTo(181.046, 2);
    expect(a.peaks[1].relative).toBeGreaterThan(9.5);
    expect(a.peaks[1].relative).toBeLessThan(10.5);
    expect(a.peaks[2].relative).toBeGreaterThan(1);
    expect(a.peaks[2].relative).toBeLessThan(1.6);
    expect(a.approximate).toBe(false);
    expect(analysisText(a)).toContain('Elemental Analysis: C, 60.00; H, 4.48; O, 35.52');
  });

  it('counts hydrogens in context for part of a molecule', () => {
    const mol = fromSmiles('CC1=CC=CC=C1');
    const methyl = [...mol.atoms.keys()][0];
    expect(analyze(mol, [methyl]).formulaText).toBe('CH3');
  });

  it('takes the electrons off a cation', () => {
    const mol = new Molecule();
    mol.addAtom({ x: 0, y: 0 }, 'N', 1);
    const a = analyze(mol);
    expect(a.formulaText).toBe('H4N+');
    expect(a.exactMass).toBeCloseTo(18.0338, 4);
    expect(a.peaks[0].mz).toBeCloseTo(18.0338, 4);
  });

  it('shows the chlorine M+2 peak', () => {
    const a = analyze(fromSmiles('ClC1=CC=CC=C1'));
    expect(a.exactMass).toBeCloseTo(112.008, 3);
    const m2 = a.peaks.find((pk) => Math.round(pk.mz) === 114)!;
    expect(m2.relative).toBeGreaterThan(31);
    expect(m2.relative).toBeLessThan(33.5);
  });

  it('shows the 1:2:1 pattern of two bromines', () => {
    const a = analyze(fromSmiles('BrCBr'));
    const at = (n: number) => a.peaks.find((pk) => Math.round(pk.mz) === n)!.relative;
    expect(at(172)).toBeCloseTo(51.4, 0);
    expect(at(174)).toBe(100);
    expect(at(176)).toBeCloseTo(48.6, 0);
  });

  it('flags elements it has no isotope data for', () => {
    const mol = new Molecule();
    mol.addAtom({ x: 0, y: 0 }, 'Ru');
    expect(analyze(mol).approximate).toBe(true);
  });
});

