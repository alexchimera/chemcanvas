import { chargeText, formulaOf, hillOrder } from '../core/chemistry';
import type { BondStyle } from '../core/edits';
import { deg, type Vec } from '../core/geometry';
import type { ChemCanvasApp } from './app';
import { ICONS } from './icons';
import type { MenuEntry, MenuSpec } from './menu';

export type MenuTarget = { kind: 'atom'; id: number } | { kind: 'bond'; id: number } | { kind: 'selection' } | { kind: 'canvas'; at: Vec };

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const mod = (key: string, shift = false) => (MAC ? `${shift ? '⇧' : ''}⌘${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`);
const DELETE = MAC ? '⌫' : 'Del';

const ELEMENTS = ['C', 'N', 'O', 'S', 'P', 'F', 'Cl', 'Br', 'I', 'H'];
const BOND_STYLES: [BondStyle, string][] = [
  ['single', 'Single bond'],
  ['double', 'Double bond'],
  ['triple', 'Triple bond'],
  ['wedge', 'Wedged bond'],
  ['hash', 'Hashed bond'],
  ['wavy', 'Wavy bond'],
];

const divider: MenuEntry = { kind: 'divider' };
const glyph = (text: string) => `<span class="glyph">${text}</span>`;
const SUB = '₀₁₂₃₄₅₆₇₈₉';
const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹';
const digits = (n: number, set: string) => [...String(n)].map((d) => set[+d]).join('');

/** A formula in plain text with real sub- and superscripts (C₉H₈O₄, H₄N⁺), for menu headers. */
function formula(app: ChemCanvasApp, atoms?: Iterable<number>): string {
  const f = formulaOf(app.mol, atoms);
  const body = hillOrder(f.counts)
    .map(([el, n]) => (n > 1 ? el + digits(n, SUB) : el))
    .join('');
  const z = Math.abs(f.charge);
  return f.charge ? `${body}${z > 1 ? digits(z, SUP) : ''}${f.charge > 0 ? '⁺' : '⁻'}` : body;
}

/**
 * The menus behind right-click and hold-and-let-go, after ChemDraw's: what
 * you can do to an atom, a bond, a selection, or the empty canvas.
 */
export function buildMenu(app: ChemCanvasApp, target: MenuTarget): MenuSpec | null {
  switch (target.kind) {
    case 'atom':
      return atomMenu(app, target.id);
    case 'bond':
      return bondMenu(app, target.id);
    case 'selection':
      return app.selection.size ? selectionMenu(app) : null;
    case 'canvas':
      return canvasMenu(app, target.at);
  }
}

/** "Select molecule", "Clean up molecule", "Analysis" for whatever molecule an atom is in. */
function moleculeEntries(app: ChemCanvasApp, atom: number): MenuEntry[] {
  return [
    { kind: 'action', label: 'Select molecule', icon: ICONS.molecule, run: () => app.selectMolecule(atom) },
    { kind: 'action', label: 'Clean up molecule', icon: ICONS.tidy, shortcut: 'T', run: () => app.cleanup(app.mol.fragmentOf(atom)) },
    {
      kind: 'action',
      label: 'Analysis',
      icon: ICONS.analysis,
      run: () => {
        app.selectMolecule(atom);
        app.showAnalysis();
      },
    },
  ];
}

function atomMenu(app: ChemCanvasApp, id: number): MenuSpec | null {
  const atom = app.mol.atoms.get(id);
  if (!atom) return null;
  return {
    title: `${atom.element}${chargeText(atom.charge)} atom`,
    subtitle: `in ${formula(app, app.mol.fragmentOf(id))}`,
    entries: [
      {
        kind: 'chips',
        chips: [
          ...ELEMENTS.map((el) => ({
            title: `Change to ${el}`,
            label: el,
            className: `el el-${el.toLowerCase()}`,
            active: atom.element === el,
            run: () => app.setAtomElement(id, el),
          })),
          { title: 'Type another element', label: '…', className: 'more', run: () => app.editAtom(id, true) },
        ],
      },
      { kind: 'action', label: 'Add positive charge', icon: glyph('+'), shortcut: '+', run: () => app.changeCharge(id, 1) },
      { kind: 'action', label: 'Add negative charge', icon: glyph('−'), shortcut: '−', run: () => app.changeCharge(id, -1) },
      divider,
      ...moleculeEntries(app, id),
      divider,
      { kind: 'action', label: 'Delete atom', icon: ICONS.trash, shortcut: DELETE, danger: true, run: () => app.removeAtom(id) },
    ],
  };
}

function bondMenu(app: ChemCanvasApp, id: number): MenuSpec | null {
  const bond = app.mol.bonds.get(id);
  if (!bond) return null;
  const current: BondStyle = bond.stereo !== 'none' ? bond.stereo : (['single', 'double', 'triple'] as const)[bond.order - 1];
  const wedged = bond.stereo === 'wedge' || bond.stereo === 'hash';
  return {
    title: BOND_STYLES.find(([style]) => style === current)![1],
    subtitle: `in ${formula(app, app.mol.fragmentOf(bond.a))}`,
    entries: [
      {
        kind: 'chips',
        chips: BOND_STYLES.map(([style, title]) => ({
          title: style === current && wedged ? `${title}: choose again to swap ends` : title,
          icon: ICONS[style],
          active: style === current,
          run: () => app.setBond(id, style),
        })),
      },
      ...(wedged ? [{ kind: 'action', label: 'Swap narrow and wide ends', icon: ICONS.swap, run: () => app.flipWedge(id) } as MenuEntry] : []),
      divider,
      ...moleculeEntries(app, bond.a),
      divider,
      { kind: 'action', label: 'Delete bond', icon: ICONS.trash, shortcut: DELETE, danger: true, run: () => app.removeBond(id) },
    ],
  };
}

function selectionMenu(app: ChemCanvasApp): MenuSpec {
  const atoms = [...app.selection];
  const n = atoms.length;
  const several = n > 1;
  return {
    title: n === 1 ? '1 atom selected' : `${n} atoms selected`,
    subtitle: formula(app, atoms),
    entries: [
      ...(several
        ? [
            {
              kind: 'chips',
              chips: [
                { title: 'Rotate 90° left', icon: ICONS.rotateLeft, run: () => app.rotateSelection(deg(-90)) },
                { title: 'Rotate 90° right', icon: ICONS.rotateRight, run: () => app.rotateSelection(deg(90)) },
                { title: 'Flip horizontal', icon: ICONS.flipH, run: () => app.flipSelection('horizontal') },
                { title: 'Flip vertical', icon: ICONS.flipV, run: () => app.flipSelection('vertical') },
              ],
            } as MenuEntry,
          ]
        : []),
      { kind: 'action', label: 'Cut', icon: ICONS.cut, shortcut: mod('X'), run: () => app.cutSelection() },
      { kind: 'action', label: 'Copy', icon: ICONS.copy, shortcut: mod('C'), run: () => void app.copySelection() },
      { kind: 'action', label: 'Duplicate', icon: ICONS.duplicate, shortcut: mod('D'), run: () => app.duplicateSelection() },
      divider,
      { kind: 'action', label: 'Clean up', icon: ICONS.tidy, shortcut: 'T', run: () => app.cleanupSelection() },
      { kind: 'action', label: 'Analysis', icon: ICONS.analysis, run: () => app.showAnalysis() },
      {
        kind: 'chips',
        label: 'Copy as',
        chips: [
          { title: 'Copy as SMILES', label: 'SMILES', className: 'text', run: () => void app.copyAs('smiles', atoms) },
          { title: 'Copy as Molfile', label: 'Molfile', className: 'text', run: () => void app.copyAs('molfile', atoms) },
          { title: 'Copy as SVG', label: 'SVG', className: 'text', run: () => void app.copyAs('svg', atoms) },
        ],
      },
      divider,
      { kind: 'action', label: 'Select all', icon: ICONS.selectAll, shortcut: mod('A'), run: () => app.selectAll() },
      { kind: 'action', label: 'Deselect', icon: ICONS.deselect, shortcut: 'Esc', run: () => app.deselect() },
      divider,
      { kind: 'action', label: 'Delete', icon: ICONS.trash, shortcut: DELETE, danger: true, run: () => app.deleteSelection() },
    ],
  };
}

function canvasMenu(app: ChemCanvasApp, at: Vec): MenuSpec {
  const empty = app.mol.isEmpty;
  return {
    title: 'Canvas',
    subtitle: empty ? 'Nothing drawn yet' : formula(app),
    entries: [
      { kind: 'action', label: 'Paste here', icon: ICONS.paste, shortcut: mod('V'), run: () => void app.paste(at) },
      { kind: 'action', label: 'Add an atom here', icon: ICONS.atom, run: () => app.addAtomAt(at) },
      { kind: 'action', label: 'Select all', icon: ICONS.selectAll, shortcut: mod('A'), disabled: empty, run: () => app.selectAll() },
      divider,
      { kind: 'action', label: 'Clean up everything', icon: ICONS.tidy, shortcut: mod('K', true), disabled: empty, run: () => app.cleanup() },
      { kind: 'action', label: 'Analysis', icon: ICONS.analysis, disabled: empty, run: () => app.showAnalysis() },
      { kind: 'action', label: 'Fit to screen', icon: ICONS.fit, shortcut: '0', run: () => app.fit() },
      divider,
      { kind: 'action', label: 'Undo', icon: ICONS.undo, shortcut: mod('Z'), disabled: !app.canUndo, run: () => app.undo() },
      { kind: 'action', label: 'Redo', icon: ICONS.redo, shortcut: MAC ? mod('Z', true) : mod('Y'), disabled: !app.canRedo, run: () => app.redo() },
      divider,
      { kind: 'action', label: 'Clear canvas', icon: ICONS.trash, danger: true, disabled: empty, run: () => app.clear() },
    ],
  };
}
