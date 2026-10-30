import { describe, expect, it } from 'vitest';
import { angleOf, polar, sub, vec } from '../src/core/geometry';
import { Molecule } from '../src/core/molecule';
import { findRings } from '../src/core/rings';
import { closedLoop, estimateRingSize, isScribble } from '../src/gestures/stroke';
import { bondLengths, chainAngles, circle, draw, line, polygonStroke, polyline, scribble } from './helpers';

const deg = (r: number) => (r * 180) / Math.PI;

describe('stroke classification', () => {
  it('reads a wobbly circle as a closed loop and a hexagon by default', () => {
    const loop = closedLoop(circle(vec(0, 0), 1));
    expect(loop).not.toBeNull();
    expect(estimateRingSize(loop!).size).toBe(6);
  });

  it('counts corners of hand-drawn polygons', () => {
    for (const sides of [3, 4, 5, 6, 7]) {
      const loop = closedLoop(polygonStroke(vec(0, 0), 1.2, sides));
      expect(loop, `loop for ${sides} sides`).not.toBeNull();
      expect(estimateRingSize(loop!).size, `${sides} sides`).toBe(sides);
    }
  });

  it('does not read an open arc or a straight line as a loop', () => {
    expect(closedLoop(circle(vec(0, 0), 1, { sweep: Math.PI }))).toBeNull();
    expect(closedLoop(line(vec(0, 0), vec(4, 0)))).toBeNull();
  });

  it('tells a scribble from a zig-zag', () => {
    expect(isScribble(scribble(vec(0, 0), 1.2, 6))).toBe(true);
    const zigzag = polyline(Array.from({ length: 7 }, (_, k) => vec(k * 0.87, k % 2 ? -0.5 : 0)));
    expect(isScribble(zigzag)).toBe(false);
  });
});

describe('drawing bonds and chains', () => {
  it('a short flick makes one bond snapped to a 30° direction', () => {
    const mol = new Molecule();
    draw(mol, line(vec(0, 0), vec(0.95, 0.2)));
    expect(mol.atoms.size).toBe(2);
    expect(mol.bonds.size).toBe(1);
    const [bond] = mol.bonds.values();
    const dir = deg(angleOf(sub(mol.pos(bond.b), mol.pos(bond.a))));
    expect(Math.round(dir / 30) * 30).toBeCloseTo(dir, 6);
    expect(bondLengths(mol)[0]).toBeCloseTo(1, 6);
  });

  it('a long straight stroke becomes a zig-zag with 120° angles', () => {
    const mol = new Molecule();
    const plan = draw(mol, line(vec(0, 0), vec(5.2, 0), 80));
    expect(plan.kind).toBe('build');
    expect(mol.bonds.size).toBeGreaterThanOrEqual(5);
    expect(mol.bonds.size).toBeLessThanOrEqual(7);
    for (const len of bondLengths(mol)) expect(len).toBeCloseTo(1, 6);
    for (const a of chainAngles(mol)) expect(a).toBeCloseTo(120, 4);
    // The zig-zag stays near the stroke.
    for (const atom of mol.atoms.values()) expect(Math.abs(atom.y)).toBeLessThan(0.75);
  });

  it('continuing from a chain end keeps the zig-zag going', () => {
    const mol = new Molecule();
    draw(mol, line(vec(0, 0), vec(3.4, 0), 60));
    const end = [...mol.atoms.values()].find((a) => mol.degree(a.id) === 1 && a.x > 1)!;
    const before = mol.bonds.size;
    draw(mol, line(vec(end.x, end.y), vec(end.x + 3.4, end.y), 60), { startAtom: end.id });
    expect(mol.bonds.size).toBeGreaterThan(before + 2);
    for (const a of chainAngles(mol)) expect(a).toBeCloseTo(120, 4);
  });

  it('retracing a bond raises its order', () => {
    const mol = new Molecule();
    draw(mol, line(vec(0, 0), vec(1, 0)));
    const [a, b] = [...mol.atoms.values()];
    draw(mol, line(vec(a.x, a.y), vec(b.x, b.y)), { startAtom: a.id, endAtom: b.id });
    expect([...mol.bonds.values()][0].order).toBe(2);
    expect(mol.atoms.size).toBe(2);
  });

  it('a stroke from atom to atom closes a ring', () => {
    const mol = new Molecule();
    // Five bonds of a hexagon, then join the two ends.
    const hex = Array.from({ length: 6 }, (_, k) => polar(-Math.PI / 2 + (k * Math.PI) / 3, 1));
    for (const p of hex) mol.addAtom(p);
    const ids = [...mol.atoms.keys()];
    for (let k = 0; k < 5; k++) mol.addBond(ids[k], ids[k + 1]);
    draw(mol, line(hex[5], hex[0]), { startAtom: ids[5], endAtom: ids[0] });
    expect(mol.bonds.size).toBe(6);
    expect(findRings(mol)).toHaveLength(1);
  });

  it('a short stroke from empty space onto an atom grows a substituent from it', () => {
    const mol = new Molecule();
    draw(mol, line(vec(0, 0), vec(1, 0)));
    const target = [...mol.atoms.values()][1];
    draw(mol, line(vec(target.x + 0.6, target.y - 0.8), vec(target.x, target.y)), { startAtom: null });
    expect(mol.atoms.size).toBe(3);
    expect(mol.degree(target.id)).toBe(2);
    for (const a of chainAngles(mol)) expect(a).toBeCloseTo(120, 4);
  });
});

describe('rings', () => {
  it('a circle in empty space makes a regular hexagon', () => {
    const mol = new Molecule();
    const plan = draw(mol, circle(vec(3, 3), 1));
    expect(plan.kind === 'build' && plan.label).toBe('6-ring');
    expect(mol.atoms.size).toBe(6);
    expect(findRings(mol)).toHaveLength(1);
    for (const len of bondLengths(mol)) expect(len).toBeCloseTo(1, 6);
  });

  it('a pentagon gesture makes a 5-membered ring', () => {
    const mol = new Molecule();
    draw(mol, polygonStroke(vec(0, 0), 0.9, 5));
    expect(findRings(mol)[0].atoms).toHaveLength(5);
  });

  it('a loop beside a ring fuses onto the shared bond (naphthalene skeleton)', () => {
    const mol = new Molecule();
    draw(mol, circle(vec(0, 0), 1));
    // Pointy-top hexagon: the right-hand vertical bond is at x = 0.866.
    draw(mol, circle(vec(1.732, 0), 1, { seed: 11 }));
    expect(mol.atoms.size).toBe(10);
    expect(mol.bonds.size).toBe(11);
    expect(findRings(mol)).toHaveLength(2);
    for (const len of bondLengths(mol)) expect(len).toBeCloseTo(1, 6);
  });

  it('a circle inside a ring makes it aromatic, and again removes the double bonds', () => {
    const mol = new Molecule();
    draw(mol, circle(vec(0, 0), 1));
    const plan = draw(mol, circle(vec(0, 0), 0.45, { seed: 5 }));
    expect(plan.kind).toBe('bond-orders');
    expect([...mol.bonds.values()].filter((b) => b.order === 2)).toHaveLength(3);
    draw(mol, circle(vec(0, 0), 0.45, { seed: 9 }));
    expect([...mol.bonds.values()].filter((b) => b.order === 2)).toHaveLength(0);
  });

  it('a loop through the end of a chain puts the ring on that atom', () => {
    const mol = new Molecule();
    draw(mol, line(vec(-2.5, 0), vec(0, 0), 40));
    const end = [...mol.atoms.values()].reduce((a, b) => (a.x > b.x ? a : b));
    const dir = angleOf(sub(mol.pos(end.id), mol.pos(mol.neighbors(end.id)[0])));
    const center = { x: end.x + Math.cos(dir), y: end.y + Math.sin(dir) };
    draw(mol, circle(center, 0.95, { start: dir + Math.PI }), { startAtom: end.id });
    const rings = findRings(mol);
    expect(rings).toHaveLength(1);
    expect(rings[0].atoms).toContain(end.id);
    for (const len of bondLengths(mol)) expect(len).toBeCloseTo(1, 6);
  });
});

describe('erasing', () => {
  it('scribbling over a bond removes it and strands nothing', () => {
    const mol = new Molecule();
    draw(mol, line(vec(0, 0), vec(4.4, 0), 60));
    const before = mol.atoms.size;
    const target = [...mol.bonds.values()][1];
    const mid = { x: (mol.atoms.get(target.a)!.x + mol.atoms.get(target.b)!.x) / 2, y: (mol.atoms.get(target.a)!.y + mol.atoms.get(target.b)!.y) / 2 };
    const plan = draw(mol, scribble(mid, 0.5, 6), { startAtom: null, endAtom: null });
    expect(plan.kind).toBe('erase');
    expect(mol.atoms.size).toBeLessThan(before);
    for (const atom of mol.atoms.values()) expect(mol.degree(atom.id)).toBeGreaterThan(0);
  });
});
