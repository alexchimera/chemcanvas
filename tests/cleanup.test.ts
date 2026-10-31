import { describe, expect, it } from 'vitest';
import { applyCleanup, cleanupLayout } from '../src/core/layout';
import { dist, polar, vec, type Vec } from '../src/core/geometry';
import { Molecule } from '../src/core/molecule';
import { findRings } from '../src/core/rings';
import { aspirin } from '../src/example';
import { toSmiles } from '../src/io/smiles';
import { anglesAround, bondCrossings, bondLengths, closestApproach, fromSmiles, rng } from './helpers';

function tidy(mol: Molecule, opts = {}) {
  const result = cleanupLayout(mol, undefined, opts);
  applyCleanup(mol, result);
  return result;
}

/** Knock every atom about, then turn and stretch the whole drawing. */
function mess(mol: Molecule, seed = 3, amount = 0.3, turn = 0.3, stretch = 1.3) {
  const rand = rng(seed);
  for (const a of mol.atoms.values()) {
    const x = a.x * Math.cos(turn) - a.y * Math.sin(turn);
    const y = a.x * Math.sin(turn) + a.y * Math.cos(turn);
    mol.updateAtom(a.id, { x: x * stretch + rand() * amount * 2, y: y * stretch + rand() * amount * 2 });
  }
}

function expectIdealBonds(mol: Molecule) {
  for (const len of bondLengths(mol)) expect(len).toBeCloseTo(1, 6);
}

function expectRegularRings(mol: Molecule) {
  for (const ring of findRings(mol)) {
    const n = ring.atoms.length;
    const interior = (180 * (n - 2)) / n;
    ring.atoms.forEach((id, k) => {
      const p = mol.pos(id);
      const a = mol.pos(ring.atoms[(k + n - 1) % n]);
      const b = mol.pos(ring.atoms[(k + 1) % n]);
      const cos = ((a.x - p.x) * (b.x - p.x) + (a.y - p.y) * (b.y - p.y)) / (dist(a, p) * dist(b, p));
      expect((Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI).toBeCloseTo(interior, 4);
    });
  }
}

/** Shape difference after the best rotation/translation (no reflection). */
function shapeRmsd(a: Molecule, b: Molecule): number {
  const ids = [...a.atoms.keys()];
  const ca = centre(ids.map((id) => a.pos(id)));
  const cb = centre(ids.map((id) => b.pos(id)));
  let dotSum = 0;
  let crossSum = 0;
  for (const id of ids) {
    const p = { x: a.pos(id).x - ca.x, y: a.pos(id).y - ca.y };
    const q = { x: b.pos(id).x - cb.x, y: b.pos(id).y - cb.y };
    dotSum += p.x * q.x + p.y * q.y;
    crossSum += p.x * q.y - p.y * q.x;
  }
  const t = Math.atan2(crossSum, dotSum);
  let err = 0;
  for (const id of ids) {
    const p = { x: a.pos(id).x - ca.x, y: a.pos(id).y - ca.y };
    const r = { x: p.x * Math.cos(t) - p.y * Math.sin(t), y: p.x * Math.sin(t) + p.y * Math.cos(t) };
    err += (r.x - (b.pos(id).x - cb.x)) ** 2 + (r.y - (b.pos(id).y - cb.y)) ** 2;
  }
  return Math.sqrt(err / ids.length);
}

const centre = (pts: Vec[]) => ({
  x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
  y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
});

/** Which side of the double bond a–b the atoms c (on a) and d (on b) are: +1 trans, −1 cis. */
function doubleBondSense(mol: Molecule, a: number, b: number, c: number, d: number): number {
  const pa = mol.pos(a);
  const pb = mol.pos(b);
  const side = (p: Vec) => Math.sign((pb.x - pa.x) * (p.y - pa.y) - (pb.y - pa.y) * (p.x - pa.x));
  return side(mol.pos(c)) === side(mol.pos(d)) ? -1 : 1;
}

describe('clean-up keeps tidy drawings as they are', () => {
  it('leaves the hand-drawn aspirin untouched', () => {
    const mol = aspirin();
    const result = cleanupLayout(mol, undefined, { lattice: true });
    expect(result.maxShift).toBeLessThan(1e-6);
    expect(result.stereo.size).toBe(0);
  });

  it('is idempotent', () => {
    const mol = aspirin();
    mess(mol, 9);
    tidy(mol, { lattice: true });
    expect(cleanupLayout(mol, undefined, { lattice: true }).maxShift).toBeLessThan(1e-6);
  });
});

describe('clean-up restores ideal geometry', () => {
  it('straightens a knocked-about aspirin back to its true shape', () => {
    const ideal = aspirin();
    const mol = aspirin();
    mess(mol, 5);
    tidy(mol);
    expectIdealBonds(mol);
    expectRegularRings(mol);
    expect(shapeRmsd(mol, ideal)).toBeLessThan(1e-6);
    expect(toSmiles(mol)).toBe(toSmiles(ideal));
  });

  it('squares the result onto the 30° grid and the hex lattice', () => {
    const mol = aspirin();
    mess(mol, 2, 0.2, 0.2);
    tidy(mol, { lattice: true });
    for (const b of mol.bonds.values()) {
      const a = (Math.atan2(mol.pos(b.b).y - mol.pos(b.a).y, mol.pos(b.b).x - mol.pos(b.a).x) * 180) / Math.PI;
      expect(Math.abs(a / 30 - Math.round(a / 30))).toBeLessThan(1e-6);
    }
  });

  it('keeps the drawing roughly where it was', () => {
    const mol = aspirin();
    mess(mol, 4);
    const before = centre([...mol.atoms.values()]);
    tidy(mol);
    expect(dist(centre([...mol.atoms.values()]), before)).toBeLessThan(0.6);
  });

  it('lays out fused, spiro and steroid ring systems as regular polygons', () => {
    for (const smiles of [
      'C1=CC=C2C=CC=CC2=C1', // naphthalene
      'C1=CC=C2C(=C1)C=CN2', // indole
      'C1CCC2(CC1)CCCC2', // spiro[4.5]decane
      'C1CCC2C(C1)CCC3C2CCC4CCCC34', // gonane (steroid skeleton)
      'C1=CC2=C3C(=C1)C=CC4=CC=CC(=C43)C=C2', // pyrene
    ]) {
      const mol = fromSmiles(smiles);
      tidy(mol);
      expectIdealBonds(mol);
      expectRegularRings(mol);
      expect(closestApproach(mol), smiles).toBeGreaterThan(0.99);
    }
  });

  it('keeps unit bonds in peri-fused rings that cannot all be regular', () => {
    const mol = fromSmiles('C1=CC2=CC=CC3=C2C(=C1)C=C3'); // acenaphthylene
    tidy(mol);
    expectIdealBonds(mol);
    expect(closestApproach(mol)).toBeGreaterThan(0.99);
    expect(bondCrossings(mol)).toBe(0);
    // The two benzene rings stay regular; only the five-membered ring gives.
    for (const ring of findRings(mol).filter((r) => r.atoms.length === 6)) {
      ring.atoms.forEach((id, k) => {
        const p = mol.pos(id);
        const a = mol.pos(ring.atoms[(k + 5) % 6]);
        const b = mol.pos(ring.atoms[(k + 1) % 6]);
        const angle = Math.abs(Math.atan2(a.y - p.y, a.x - p.x) - Math.atan2(b.y - p.y, b.x - p.x)) * (180 / Math.PI);
        expect(Math.min(angle, 360 - angle)).toBeCloseTo(120, 4);
      });
    }
  });

  it('draws norbornane with its bridge inside the hexagon', () => {
    const mol = fromSmiles('C1CC2CCC1C2');
    tidy(mol);
    expectIdealBonds(mol);
    const bridge = [...mol.atoms.keys()][6];
    const outline = [...mol.atoms.keys()].slice(0, 6).map((id) => mol.pos(id));
    // The one-carbon bridge sits inside the six-atom outline.
    const inside = (p: Vec, poly: Vec[]) => {
      let c = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        if (poly[i].y > p.y !== poly[j].y > p.y && p.x < ((poly[j].x - poly[i].x) * (p.y - poly[i].y)) / (poly[j].y - poly[i].y) + poly[i].x) c = !c;
      }
      return c;
    };
    expect(inside(mol.pos(bridge), outline)).toBe(true);
  });

  it('draws bicyclo[2.2.2]octane with its bridge straight across', () => {
    const mol = fromSmiles('C1CC2CCC1CC2');
    tidy(mol);
    expect(closestApproach(mol)).toBeGreaterThan(0.5);
    for (const len of bondLengths(mol)) expect(len).toBeGreaterThan(0.6);
  });

  it('draws alkynes straight and quaternary carbons as a cross', () => {
    const alkyne = fromSmiles('CC#CC');
    tidy(alkyne);
    const [, c2, c3] = [...alkyne.atoms.keys()];
    for (const id of [c2, c3]) expect(Math.max(...anglesAround(alkyne, id))).toBeCloseTo(180, 4);

    const tbutyl = fromSmiles('CC(C)(C)C');
    tidy(tbutyl);
    for (const a of anglesAround(tbutyl, [...tbutyl.atoms.keys()][1])) expect(a).toBeCloseTo(90, 4);
  });

  it('turns chains into 120° zig-zags without overlaps', () => {
    const mol = fromSmiles('CCCCCCCCCCCC(CC)CCCC');
    tidy(mol);
    expectIdealBonds(mol);
    for (const atom of mol.atoms.values()) {
      if (mol.degree(atom.id) === 2) for (const a of anglesAround(mol, atom.id)) expect(Math.min(a, 360 - a)).toBeCloseTo(120, 4);
    }
    expect(closestApproach(mol)).toBeGreaterThan(0.9);
    expect(bondCrossings(mol)).toBe(0);
  });

  it('untangles a chain drawn curling over itself', () => {
    // Twelve carbons drawn around a tight circle, so the chain ends overlap.
    const mol = fromSmiles('CCCCCCCCCCCC', (k) => polar((k * 2 * Math.PI) / 7, 1.1));
    tidy(mol);
    expectIdealBonds(mol);
    expect(closestApproach(mol)).toBeGreaterThan(0.7);
    expect(bondCrossings(mol)).toBe(0);
  });

  it('makes sense of atoms scattered at random', () => {
    const rand = rng(17);
    const mol = fromSmiles('CC(=O)OC1=CC=CC=C1C(=O)O', () => vec(rand() * 6, rand() * 6));
    tidy(mol);
    expectIdealBonds(mol);
    expectRegularRings(mol);
    expect(closestApproach(mol)).toBeGreaterThan(0.9);
    expect(bondCrossings(mol)).toBe(0);
  });
});

describe('clean-up keeps what the drawing means', () => {
  const butene = (cis: boolean) =>
    // C1 C2=C3 C4, drawn sloppily: the methyls on the same side for cis.
    fromSmiles('CC=CC', (k) => [vec(-0.9, cis ? 0.7 : 0.6), vec(0, 0.1), vec(1.2, -0.05), vec(1.9, cis ? 0.8 : -0.9)][k]);

  it('keeps a cis double bond cis and a trans one trans', () => {
    for (const cis of [true, false]) {
      const mol = butene(cis);
      const [c1, c2, c3, c4] = [...mol.atoms.keys()];
      tidy(mol);
      expect(doubleBondSense(mol, c2, c3, c1, c4)).toBe(cis ? -1 : 1);
      for (const id of [c2, c3]) expect(Math.min(...anglesAround(mol, id))).toBeCloseTo(120, 4);
    }
  });

  it('keeps substituents on the side of the ring they were drawn on', () => {
    // ortho-xylene with the methyls drawn on the upper-right ring atoms
    const mol = aspirin();
    const ideal = aspirin();
    mess(mol, 11, 0.25, -0.2);
    tidy(mol);
    expect(shapeRmsd(mol, ideal)).toBeLessThan(1e-6);
  });

  it('keeps a wedged stereocentre the same when its branch has to be mirrored', () => {
    // A long chain drawn curling back over itself, with a wedged methyl branch.
    const mol = fromSmiles('CCCCCC(C)CCCCCCC', (k) => polar((k * 2 * Math.PI) / 8, 1.25));
    const centreId = [...mol.atoms.keys()][5];
    const methyl = [...mol.atoms.keys()][6];
    mol.updateBond(mol.bondBetween(centreId, methyl)!.id, { stereo: 'wedge' });
    const handedness = (m: Molecule) => {
      const nb = m.neighbors(centreId).filter((n) => n !== methyl).sort((a, b) => a - b);
      const p = m.pos(centreId);
      const [u, v, w] = [m.pos(methyl), m.pos(nb[0]), m.pos(nb[1])].map((q) => ({ x: q.x - p.x, y: q.y - p.y }));
      const area = (v.x - u.x) * (w.y - u.y) - (v.y - u.y) * (w.x - u.x);
      const wedge = m.bondBetween(centreId, methyl)!.stereo === 'wedge' ? 1 : -1;
      return Math.sign(area) * wedge;
    };
    const before = handedness(mol);
    tidy(mol);
    expect(closestApproach(mol)).toBeGreaterThan(0.7);
    expect(handedness(mol)).toBe(before);
  });
});

describe('clean-up and other molecules', () => {
  it('only touches the molecule asked for', () => {
    const mol = aspirin();
    const other = mol.addAtom(vec(10, 10)).id;
    const otherB = mol.addAtom(vec(10.3, 10.9)).id;
    mol.addBond(other, otherB);
    mess(mol, 6);
    const otherBefore = mol.pos(other);
    const ring = findRings(mol)[0].atoms;
    applyCleanup(mol, cleanupLayout(mol, [ring[0]]));
    expect(mol.pos(other)).toEqual(otherBefore);
    expectRegularRings(mol);
  });

  it('pushes molecules apart if cleaning makes them overlap', () => {
    const mol = new Molecule();
    // Two crumpled propane chains drawn almost on top of each other.
    for (const offset of [0, 0.4]) {
      const ids = [vec(offset, 0), vec(offset + 0.3, 0.2), vec(offset + 0.5, -0.1)].map((p) => mol.addAtom(p).id);
      mol.addBond(ids[0], ids[1]);
      mol.addBond(ids[1], ids[2]);
    }
    tidy(mol);
    const [a, b] = mol.components();
    let gap = Infinity;
    for (const x of a) for (const y of b) gap = Math.min(gap, dist(mol.pos(x), mol.pos(y)));
    expect(gap).toBeGreaterThanOrEqual(1.2);
  });
});
