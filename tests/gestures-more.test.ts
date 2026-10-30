import { describe, expect, it } from 'vitest';
import { add, angleOf, dist, polar, sub, vec, type Vec } from '../src/core/geometry';
import { Molecule } from '../src/core/molecule';
import { findRings } from '../src/core/rings';
import { aromatizePlan } from '../src/gestures/ring';
import { applyPlan } from '../src/gestures/plan';
import { toSmiles } from '../src/io/smiles';
import { bondLengths, chainAngles, circle, draw, line, polygonStroke, scribble } from './helpers';

const deg = (r: number) => (r * 180) / Math.PI;

function hexagon(mol: Molecule, center: Vec = vec(0, 0)): number[] {
  const ids = Array.from({ length: 6 }, (_, k) => mol.addAtom(add(center, polar(-Math.PI / 2 + (k * Math.PI) / 3, 1))).id);
  ids.forEach((id, k) => mol.addBond(id, ids[(k + 1) % 6]));
  return ids;
}

describe('chains in any direction', () => {
  for (const angle of [0, 30, 60, 90, 135, 200, 300]) {
    it(`follows a straight stroke at ${angle}°`, () => {
      const mol = new Molecule();
      const dir = polar((angle * Math.PI) / 180, 1);
      draw(mol, line(vec(0, 0), { x: dir.x * 4.5, y: dir.y * 4.5 }, 60));
      expect(mol.bonds.size).toBeGreaterThanOrEqual(4);
      for (const len of bondLengths(mol)) expect(len).toBeCloseTo(1, 6);
      for (const a of chainAngles(mol)) expect(a).toBeCloseTo(120, 4);
      // Every atom stays close to the stroke line.
      for (const atom of mol.atoms.values()) {
        const along = atom.x * dir.x + atom.y * dir.y;
        const off = Math.abs(atom.x * dir.y - atom.y * dir.x);
        expect(off).toBeLessThan(0.9);
        expect(along).toBeGreaterThan(-0.6);
      }
    });
  }

  it('bends along a curved stroke', () => {
    const mol = new Molecule();
    const arc = Array.from({ length: 80 }, (_, i) => {
      const t = Math.PI + (i / 79) * (Math.PI * 0.9);
      return add(vec(0, 0), polar(t, 3.2));
    });
    draw(mol, arc);
    expect(mol.bonds.size).toBeGreaterThanOrEqual(7);
    for (const a of chainAngles(mol)) expect(a).toBeCloseTo(120, 4);
    for (const atom of mol.atoms.values()) expect(Math.abs(dist(atom, vec(0, 0)) - 3.2)).toBeLessThan(0.9);
  });

  it('grows a ring substituent outward along the bisector', () => {
    const mol = new Molecule();
    const ring = hexagon(mol);
    const top = mol.atoms.get(ring[0])!;
    draw(mol, line(vec(top.x + 0.05, top.y), vec(top.x + 0.1, top.y - 0.95)), { startAtom: ring[0] });
    const sub1 = mol.neighbors(ring[0]).find((n) => !ring.includes(n))!;
    expect(sub1).toBeDefined();
    expect(deg(angleOf(sub(mol.pos(sub1), mol.pos(ring[0]))))).toBeCloseTo(-90, 4);
  });

  it('ignores a tiny jiggle', () => {
    const mol = new Molecule();
    const plan = draw(mol, line(vec(0, 0), vec(0.15, 0.05), 5));
    expect(plan.kind).toBe('none');
    expect(mol.atoms.size).toBe(0);
  });
});

describe('ring gestures', () => {
  it('fuses a pentagon onto a hexagon bond (indane skeleton)', () => {
    const mol = new Molecule();
    hexagon(mol);
    // Right-hand vertical bond of the pointy-top hexagon is at x = 0.866.
    draw(mol, polygonStroke(vec(0.866 + 0.69, 0), 0.85, 5, Math.PI));
    expect(mol.atoms.size).toBe(9);
    const sizes = findRings(mol).map((r) => r.atoms.length).sort();
    expect(sizes).toEqual([5, 6]);
    for (const len of bondLengths(mol)) expect(len).toBeCloseTo(1, 6);
  });

  it('accepts a loop that overshoots its start', () => {
    const mol = new Molecule();
    draw(mol, circle(vec(0, 0), 1, { sweep: Math.PI * 2.35 }));
    expect(findRings(mol)).toHaveLength(1);
    expect(findRings(mol)[0].atoms).toHaveLength(6);
  });

  it('a loop beside a chain end hangs a ring off it by a new bond', () => {
    const mol = new Molecule();
    draw(mol, line(vec(-2.6, 0), vec(0, 0), 40));
    const end = [...mol.atoms.values()].reduce((a, b) => (a.x > b.x ? a : b));
    const ideal = mol.neighbors(end.id).map((n) => angleOf(sub(mol.pos(end.id), mol.pos(n))))[0];
    // Centre the loop one bond plus one ring radius away, along a 120° direction.
    const dir = ideal + (Math.sign(Math.sin(ideal)) || 1) * (Math.PI / 3);
    const center = add(end, polar(dir, 2));
    draw(mol, circle(center, 0.95), { startAtom: null, endAtom: null });
    const rings = findRings(mol);
    expect(rings).toHaveLength(1);
    expect(rings[0].atoms).not.toContain(end.id);
    expect(mol.fragmentOf(end.id)).toHaveLength(mol.atoms.size);
  });

  it('a lollipop stroke from an atom (tail then loop) still makes a ring', () => {
    const mol = new Molecule();
    draw(mol, line(vec(0, 0), vec(1, 0)));
    const start = mol.atoms.get([...mol.atoms.keys()][1])!;
    const tail = line(vec(start.x, start.y), vec(start.x + 1, start.y), 10);
    const loop = circle(vec(start.x + 2, start.y), 1, { start: Math.PI });
    draw(mol, [...tail, ...loop], { startAtom: start.id });
    expect(findRings(mol)).toHaveLength(1);
  });
});

describe('erase and aromatic edge cases', () => {
  it('a scribble over empty paper does nothing', () => {
    const mol = new Molecule();
    hexagon(mol);
    const plan = draw(mol, scribble(vec(6, 6), 1, 6), { startAtom: null, endAtom: null });
    expect(plan.kind).toBe('erase');
    expect(mol.atoms.size).toBe(6);
  });

  it('leaves the NH of a pyrrole-type ring single-bonded', () => {
    const mol = new Molecule();
    const ids = Array.from({ length: 5 }, (_, k) => mol.addAtom(polar(-Math.PI / 2 + (k * 2 * Math.PI) / 5, 0.85)).id);
    ids.forEach((id, k) => mol.addBond(id, ids[(k + 1) % 5]));
    mol.updateAtom(ids[0], { element: 'N' });
    applyPlan(mol, aromatizePlan(mol, findRings(mol)[0]));
    expect([...mol.bonds.values()].filter((b) => b.order === 2)).toHaveLength(2);
    expect(mol.bondsOf(ids[0]).every((b) => b.order === 1)).toBe(true);
    expect(toSmiles(mol)).toContain('N');
  });

  it('pyridine gets three double bonds including one to N', () => {
    const mol = new Molecule();
    const ids = hexagon(mol);
    mol.updateAtom(ids[0], { element: 'N' });
    applyPlan(mol, aromatizePlan(mol, findRings(mol)[0]));
    expect([...mol.bonds.values()].filter((b) => b.order === 2)).toHaveLength(3);
    expect(mol.bondsOf(ids[0]).some((b) => b.order === 2)).toBe(true);
  });
});
