import { polar, type Vec } from './core/geometry';
import { Molecule, type BondOrder } from './core/molecule';

/**
 * Aspirin, laid out on the hex lattice so it looks hand-drawn with the app.
 * Shown on first launch so the canvas opens in a working state.
 */
export function aspirin(): Molecule {
  const mol = new Molecule();
  const ring = Array.from({ length: 6 }, (_, k) => polar(-Math.PI / 2 + (k * Math.PI) / 3, 1));
  const at = (p: Vec, element = 'C') => mol.addAtom(p, element).id;
  const r = ring.map((p) => at(p));
  const orders: BondOrder[] = [1, 2, 1, 2, 1, 2];
  r.forEach((id, k) => mol.addBond(id, r[(k + 1) % 6], orders[k]));

  // Carboxylic acid on the top carbon.
  const acid = at({ x: 0, y: -2 });
  mol.addBond(r[0], acid);
  mol.addBond(acid, at({ x: -0.866, y: -2.5 }, 'O'), 2);
  mol.addBond(acid, at({ x: 0.866, y: -2.5 }, 'O'));

  // Acetoxy group on the upper-right carbon.
  const ester = at({ x: 1.732, y: -1 }, 'O');
  mol.addBond(r[1], ester);
  const carbonyl = at({ x: 2.598, y: -0.5 });
  mol.addBond(ester, carbonyl);
  mol.addBond(carbonyl, at({ x: 2.598, y: 0.5 }, 'O'), 2);
  mol.addBond(carbonyl, at({ x: 3.464, y: -1 }));
  return mol;
}
