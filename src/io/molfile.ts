import { dist, meanPoint } from '../core/geometry';
import { isElement } from '../core/elements';
import type { BondOrder, BondStereo, Molecule, MoleculeData } from '../core/molecule';

/** MDL files conventionally use ~1.5 Å bonds; model space uses 1. */
const ANGSTROM_PER_BOND = 1.5;

const STEREO_CODE: Record<BondStereo, number> = { none: 0, wedge: 1, hash: 6, wavy: 4 };

const pad = (v: string | number, width: number) => String(v).padStart(width);

/** Write an MDL Molfile (V2000). Hydrogens stay implicit, as in the drawing. */
export function toMolfile(mol: Molecule, title = ''): string {
  const atoms = [...mol.atoms.values()];
  const index = new Map(atoms.map((a, i) => [a.id, i + 1]));
  const center = meanPoint(atoms);
  const lines = [title, '  ChemCanvas          2D', ''];
  lines.push(`${pad(atoms.length, 3)}${pad(mol.bonds.size, 3)}  0  0  0  0  0  0  0  0999 V2000`);
  for (const a of atoms) {
    const x = ((a.x - center.x) * ANGSTROM_PER_BOND).toFixed(4);
    const y = (-(a.y - center.y) * ANGSTROM_PER_BOND).toFixed(4);
    lines.push(`${pad(x, 10)}${pad(y, 10)}${pad('0.0000', 10)} ${a.element.padEnd(3)} 0  0  0  0  0  0  0  0  0  0  0  0`);
  }
  for (const b of mol.bonds.values()) {
    lines.push(`${pad(index.get(b.a)!, 3)}${pad(index.get(b.b)!, 3)}${pad(b.order, 3)}${pad(STEREO_CODE[b.stereo], 3)}`);
  }
  const charged = atoms.filter((a) => a.charge !== 0);
  for (let i = 0; i < charged.length; i += 8) {
    const chunk = charged.slice(i, i + 8);
    lines.push(`M  CHG${pad(chunk.length, 3)}${chunk.map((a) => ` ${pad(index.get(a.id)!, 3)} ${pad(a.charge, 3)}`).join('')}`);
  }
  lines.push('M  END');
  return `${lines.join('\n')}\n`;
}

const CHARGE_CODE: Record<number, number> = { 1: 3, 2: 2, 3: 1, 4: 0, 5: -1, 6: -2, 7: -3 };
const STEREO_FROM_CODE: Record<number, BondStereo> = { 1: 'wedge', 6: 'hash', 4: 'wavy' };

/**
 * Read a V2000 Molfile into model space: bonds rescaled to unit length and
 * y flipped to screen orientation. Explicit hydrogens are kept as atoms.
 */
export function parseMolfile(text: string): MoleculeData {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const countsAt = lines.findIndex((l) => /V2000\s*$/.test(l));
  if (countsAt < 0) {
    if (lines.some((l) => /V3000/.test(l))) throw new Error('V3000 Molfiles are not supported yet; save as V2000.');
    throw new Error('This does not look like a Molfile (no V2000 counts line).');
  }
  const counts = lines[countsAt];
  const nAtoms = parseInt(counts.slice(0, 3), 10);
  const nBonds = parseInt(counts.slice(3, 6), 10);
  if (!Number.isFinite(nAtoms) || !Number.isFinite(nBonds)) throw new Error('The Molfile counts line is malformed.');

  const atoms: MoleculeData['atoms'] = [];
  for (let i = 0; i < nAtoms; i++) {
    const l = lines[countsAt + 1 + i];
    if (l === undefined) throw new Error('The Molfile ends before all atoms are listed.');
    const element = l.slice(31, 34).trim();
    atoms.push({
      id: i + 1,
      x: parseFloat(l.slice(0, 10)),
      y: -parseFloat(l.slice(10, 20)),
      element: isElement(element) ? element : 'C',
      charge: CHARGE_CODE[parseInt(l.slice(36, 39), 10)] ?? 0,
    });
  }
  const bonds: MoleculeData['bonds'] = [];
  for (let i = 0; i < nBonds; i++) {
    const l = lines[countsAt + 1 + nAtoms + i];
    if (l === undefined) throw new Error('The Molfile ends before all bonds are listed.');
    const type = parseInt(l.slice(6, 9), 10);
    bonds.push({
      id: nAtoms + i + 1,
      a: parseInt(l.slice(0, 3), 10),
      b: parseInt(l.slice(3, 6), 10),
      order: (type >= 1 && type <= 3 ? type : 1) as BondOrder,
      stereo: STEREO_FROM_CODE[parseInt(l.slice(9, 12), 10)] ?? 'none',
    });
  }
  const chgLines = lines.slice(countsAt + 1 + nAtoms + nBonds).filter((l) => l.startsWith('M  CHG'));
  if (chgLines.length) for (const a of atoms) a.charge = 0;
  for (const l of chgLines) {
    const fields = l.slice(6).trim().split(/\s+/).map(Number);
    for (let k = 1; k + 1 < fields.length; k += 2) {
      const atom = atoms[fields[k] - 1];
      if (atom) atom.charge = fields[k + 1];
    }
  }

  const lengths = bonds.map((b) => dist(atoms[b.a - 1], atoms[b.b - 1])).filter((d) => d > 1e-6).sort((p, q) => p - q);
  const median = lengths.length ? lengths[lengths.length >> 1] : ANGSTROM_PER_BOND;
  for (const a of atoms) {
    a.x /= median;
    a.y /= median;
  }
  return { atoms, bonds, nextId: nAtoms + nBonds + 1 };
}
