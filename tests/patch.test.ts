import { describe, expect, it } from 'vitest';
import { taggedIds } from '../src/collab/protocol';
import { History } from '../src/core/history';
import { Molecule } from '../src/core/molecule';
import { applyPatch, diffMolecules, invertPatch, isEmptyPatch, parsePatch } from '../src/core/patch';
import { aspirin } from '../src/example';
import { toSmiles } from '../src/io/smiles';

/** Make a change and return the patch for it, as the app does. */
function change(mol: Molecule, edit: (m: Molecule) => void) {
  const before = mol.toJSON();
  edit(mol);
  return diffMolecules(before, mol.toJSON());
}

describe('patches', () => {
  it('records only what changed', () => {
    const mol = aspirin();
    const first = [...mol.atoms.keys()][0];
    const p = change(mol, (m) => m.updateAtom(first, { element: 'N' }));
    expect(p.atoms).toHaveLength(1);
    expect(p.bonds).toHaveLength(0);
    expect(p.atoms[0].before!.element).toBe('C');
    expect(p.atoms[0].after!.element).toBe('N');
    expect(isEmptyPatch(change(mol, () => {}))).toBe(true);
  });

  it('applies forwards and backwards', () => {
    const mol = aspirin();
    const start = mol.toJSON();
    const p = change(mol, (m) => {
      const a = m.addAtom({ x: 5, y: 5 }, 'Cl');
      m.addBond([...m.atoms.keys()][0], a.id);
      m.removeAtom([...m.atoms.keys()][8]);
    });
    const end = mol.toJSON();
    const copy = Molecule.fromJSON(start);
    applyPatch(copy, p);
    expect(toSmiles(copy)).toBe(toSmiles(Molecule.fromJSON(end)));
    applyPatch(copy, invertPatch(p));
    expect(toSmiles(copy)).toBe(toSmiles(Molecule.fromJSON(start)));
    expect(copy.atoms.size).toBe(start.atoms.length);
  });

  it('carries a wedge turned round', () => {
    const mol = aspirin();
    const bond = [...mol.bonds.values()][6];
    mol.updateBond(bond.id, { stereo: 'wedge' });
    const copy = mol.clone();
    const p = change(mol, (m) => m.reverseBond(bond.id));
    applyPatch(copy, p);
    expect(copy.bonds.get(bond.id)).toEqual(mol.bonds.get(bond.id));
    expect(copy.neighbors(bond.a)).toContain(bond.b);
  });

  it('guarded, leaves alone what someone else changed since', () => {
    const mol = aspirin();
    const [a, b] = [...mol.atoms.keys()];
    const ax = mol.atoms.get(a)!.x;
    const mine = change(mol, (m) => {
      m.updateAtom(a, { x: 10 });
      m.updateAtom(b, { x: 20 });
    });
    mol.updateAtom(b, { x: 30 }); // someone else moves b
    const undone = applyPatch(mol, invertPatch(mine), true);
    expect(undone.atoms.map((c) => c.id)).toEqual([a]);
    expect(mol.atoms.get(a)!.x).toBe(ax);
    expect(mol.atoms.get(b)!.x).toBe(30);
  });

  it('skips a bond whose atom has gone', () => {
    const mol = aspirin();
    const p = change(mol, (m) => {
      const x = m.addAtom({ x: 9, y: 9 });
      m.addBond(x.id, [...m.atoms.keys()][3]);
    });
    const other = aspirin();
    other.removeAtom([...other.atoms.keys()][3]);
    const applied = applyPatch(other, p);
    expect(applied.bonds).toHaveLength(0);
    expect(other.atoms.size).toBe(13);
  });

  it('refuses a second bond between the same two atoms', () => {
    const mol = aspirin();
    const b = [...mol.bonds.values()][0];
    expect(mol.putBond({ id: 999, a: b.a, b: b.b, order: 2, stereo: 'none' })).toBe(false);
    expect(mol.putBond({ id: b.id, a: b.a, b: b.b, order: 2, stereo: 'none' })).toBe(true);
    expect(mol.bonds.get(b.id)!.order).toBe(2);
  });
});

describe('checking incoming patches', () => {
  const good = () => change(aspirin(), (m) => m.addAtom({ x: 1, y: 2 }, 'Br', -1));

  it('accepts a well-formed patch, dropping anything extra', () => {
    const p = good() as unknown as { atoms: Record<string, unknown>[] };
    (p.atoms[0].after as Record<string, unknown>).script = '<b>hi</b>';
    const parsed = parsePatch(JSON.parse(JSON.stringify(p)))!;
    expect(parsed.atoms[0].after).toEqual({ id: parsed.atoms[0].id, x: 1, y: 2, element: 'Br', charge: -1 });
  });

  it('rejects anything malformed', () => {
    const bad = (mutate: (p: any) => void) => {
      const p: any = JSON.parse(JSON.stringify(good()));
      mutate(p);
      return parsePatch(p);
    };
    expect(parsePatch(null)).toBeNull();
    expect(parsePatch({ atoms: 'x', bonds: [] })).toBeNull();
    expect(bad((p) => (p.atoms[0].after.element = 'script'))).toBeNull();
    expect(bad((p) => (p.atoms[0].after.x = Infinity))).toBeNull();
    expect(bad((p) => (p.atoms[0].id = -4))).toBeNull();
    expect(bad((p) => (p.atoms[0].after.id = 12345))).toBeNull();
    expect(bad((p) => p.bonds.push({ id: 7, before: null, after: { id: 7, a: 1, b: 1, order: 1, stereo: 'none' } }))).toBeNull();
    expect(bad((p) => p.bonds.push({ id: 7, before: null, after: { id: 7, a: 1, b: 2, order: 4, stereo: 'none' } }))).toBeNull();
  });
});

describe('undo history', () => {
  it('undoes and redoes patches in order', () => {
    const mol = aspirin();
    const history = new History();
    const start = toSmiles(mol);
    history.record(change(mol, (m) => m.updateAtom([...m.atoms.keys()][0], { element: 'N' })));
    const middle = toSmiles(mol);
    history.record(change(mol, (m) => m.removeAtom([...m.atoms.keys()][12])));
    applyPatch(mol, invertPatch(history.undo()!), true);
    expect(toSmiles(mol)).toBe(middle);
    applyPatch(mol, invertPatch(history.undo()!), true);
    expect(toSmiles(mol)).toBe(start);
    expect(history.canUndo).toBe(false);
    applyPatch(mol, history.redo()!, true);
    expect(toSmiles(mol)).toBe(middle);
    history.record(change(mol, (m) => m.addAtom({ x: 3, y: 3 })));
    expect(history.canRedo).toBe(false);
  });
});

describe('ids for shared drawings', () => {
  it('never repeat and stay exact', () => {
    const a = taggedIds();
    const b = taggedIds();
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) {
      for (const id of [a(), b()]) {
        expect(Number.isSafeInteger(id)).toBe(true);
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    }
  });

  it('are used for new atoms and bonds', () => {
    const mol = aspirin();
    mol.idSource = taggedIds();
    const atom = mol.addAtom({ x: 0, y: 5 });
    expect(atom.id).toBeGreaterThan(2 ** 21);
    expect(mol.addBond(atom.id, [...mol.atoms.keys()][0])!.id).toBeGreaterThan(2 ** 21);
  });
});
