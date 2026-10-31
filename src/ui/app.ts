import { analyze, type Analysis } from '../core/analysis';
import { chargeText, formulaOf, formulaWeight, hasValenceError, hillOrder } from '../core/chemistry';
import {
  addLoneAtom,
  adjustCharge,
  cycleBondOrder,
  deleteAtom,
  deleteBond,
  setBondStyle,
  setElement,
  translateAtoms,
  type BondStyle,
} from '../core/edits';
import { normalizeSymbol } from '../core/elements';
import {
  add,
  angleDiff,
  angleOf,
  boundsOf,
  clamp,
  closestOnSegment,
  deg,
  dist,
  lerp,
  midpoint,
  pointInPolygon,
  polar,
  rotateAbout,
  simplify,
  sub,
  totalTurning,
  type Box,
  type Vec,
} from '../core/geometry';
import { History } from '../core/history';
import { applyCleanup, cleanupLayout } from '../core/layout';
import { Molecule, type MoleculeData } from '../core/molecule';
import { nearestLatticePoint } from '../core/placement';
import { ringAt } from '../core/rings';
import {
  atomsInPolygon,
  boxCenter,
  clearOffset,
  extractFragment,
  flipAtoms,
  insertFragment,
  latticeShift,
  rotateAtoms,
  selectionBounds,
  type FlipAxis,
} from '../core/selection';
import { interpret, type StrokeMemory } from '../gestures/interpret';
import { applyPlan, eraseClosure, MERGE_DISTANCE, nearestAtom, NONE, type Plan } from '../gestures/plan';
import { aromatizePlan } from '../gestures/ring';
import { parseMolfile, toMolfile } from '../io/molfile';
import { toSmiles } from '../io/smiles';
import { toPng, toSvg } from '../render/export';
import { EXPORT_COLORS, readTheme, type Theme } from '../render/theme';
import { AnalysisCard } from './analysis-card';
import { copyText, readText } from './clipboard';
import { ICONS } from './icons';
import { ContextMenu } from './menu';
import { buildMenu, type MenuTarget } from './menus';
import { frameHandle, HANDLE_GAP, Renderer, type Effect, type InkPoint, type Scene } from './renderer';
import { SelectionBar } from './selection-bar';
import { View } from './view';
import { Wheel, type WheelItem } from './wheel';

type Hit = { kind: 'atom'; id: number } | { kind: 'bond'; id: number } | { kind: 'none' };

export type Tool = 'draw' | 'select';

/**
 * What a press is about to do: draw (the default), select (the Select tool,
 * or Shift on empty paper), or work on the current selection.
 */
type Zone = 'draw' | 'select' | 'selection';

interface DrawState {
  kind: 'draw';
  pointerId: number;
  pointerType: string;
  points: InkPoint[];
  plan: Plan;
  dirty: boolean;
  memory: StrokeMemory;
}

type Trail = { x: number; y: number; t: number }[];

type Mode =
  | { kind: 'idle' }
  | {
      kind: 'pending';
      pointerId: number;
      pointerType: string;
      start: Vec;
      points: InkPoint[];
      hit: Hit;
      timer: number;
      zone: Zone;
      shift: boolean;
    }
  | DrawState
  /** A press held still long enough: let go for a menu, or drag to select or move. */
  | { kind: 'held'; pointerId: number; pointerType: string; start: Vec; zone: 'canvas' | 'selection'; shift: boolean }
  /** Right button down: a click opens the menu, a drag pans. */
  | { kind: 'secondary'; pointerId: number; start: Vec; last: Vec; moved: boolean }
  /** Box or lasso selection, in screen points. */
  | { kind: 'marquee'; pointerId: number; points: Vec[]; lasso: boolean; base: Set<number> }
  | { kind: 'move-selection'; pointerId: number; last: Vec; moved: boolean; before: MoleculeData; trail: Trail }
  | {
      kind: 'rotate-selection';
      pointerId: number;
      center: Vec;
      /** Pointer angle last frame, and the unwrapped total since the press. */
      prev: number;
      raw: number;
      angle: number;
      origin: Map<number, Vec>;
      frame: Vec[];
      before: MoleculeData;
      at: Vec;
    }
  | {
      kind: 'move-atom';
      pointerId: number;
      pointerType: string;
      atom: number;
      offset: Vec;
      start: Vec;
      moved: boolean;
      before: MoleculeData;
      target: number | null;
    }
  | {
      kind: 'move-fragment';
      pointerId: number;
      pointerType: string;
      atoms: number[];
      bond: number;
      last: Vec;
      start: Vec;
      moved: boolean;
      before: MoleculeData;
      /** Recent pointer positions, to notice a shake. */
      trail: Trail;
    }
  | { kind: 'pan'; pointerId: number; last: Vec }
  | {
      kind: 'pinch';
      began: number;
      fingers: Map<number, Vec>;
      most: number;
      travel: number;
      origin: { scale: number; x: number; y: number; mid: Vec; span: number };
    };

export interface Readout {
  formula: [string, number][];
  charge: number;
  weight: number;
  smiles: string;
  atoms: number;
  valenceIssues: number;
  /** Whether the figures describe the selection or the whole drawing. */
  scope: 'all' | 'selection';
}

export interface AppHooks {
  onChange(readout: Readout): void;
  onHistory(canUndo: boolean, canRedo: boolean): void;
  onTool?(tool: Tool): void;
  toast(message: string, action?: { label: string; run: () => void }): void;
  /** The part of the canvas not covered by floating panels, for framing the drawing. */
  freeArea?(): { x: number; y: number; width: number; height: number };
}

const LONG_PRESS_MS = 420;
const STORAGE_KEY = 'chemcanvas:v1:molecule';
const ATOM_KEYS: Record<string, string> = { c: 'C', n: 'N', o: 'O', s: 'S', p: 'P', f: 'F', l: 'Cl', b: 'Br', i: 'I', h: 'H' };
const WHEEL_ELEMENTS = ['O', 'N', 'S', 'F', 'Cl', 'Br', 'I', 'P', 'H', 'C'];
const A1 = { x: Math.sqrt(3), y: 0 };

const slop = (pointerType: string) => (pointerType === 'touch' ? 10 : 6);
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const countText = (n: number) => (n === 1 ? '1 atom' : `${n} atoms`);
const vibrate = (pattern: number | number[]) => {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // Vibration is optional.
  }
};

export class ChemCanvasApp {
  readonly mol = new Molecule();
  /** Snap new structures onto the hex lattice. */
  snap = true;
  private readonly history = new History<MoleculeData>();
  private readonly view = new View();
  private readonly renderer: Renderer;
  private readonly wheel: Wheel;
  private readonly menu: ContextMenu;
  private readonly bar: SelectionBar;
  private readonly card: AnalysisCard;
  private theme: Theme;
  private mode: Mode = { kind: 'idle' };
  private currentTool: Tool = 'draw';
  private hover: Hit = { kind: 'none' };
  /** Last pointer position over the canvas (mouse and pen only), for paste and the menu key. */
  private pointer: Vec | null = null;
  private selected = new Set<number>();
  /** The last structure copied here, for when the system clipboard can't be read. */
  private clip: MoleculeData | null = null;
  private readonly touches = new Map<number, Vec>();
  private readonly swallowed = new Set<number>();
  private penSeen = false;
  private spaceHeld = false;
  private frame = 0;
  private effects: Effect[] = [];
  /** Rings that ripple out where a press turned into a hold. */
  private pulses: { at: Vec; start: number }[] = [];
  private fading: { points: InkPoint[]; tone: 'trail' | 'danger'; start: number } | null = null;
  private lastTap: { time: number; at: Vec } | null = null;
  /** What the open wheel or menu edits, highlighted on the canvas. */
  private wheelTarget: Hit = { kind: 'none' };
  private menuTarget: Hit = { kind: 'none' };
  /** Atoms gliding from their old positions after a clean-up. */
  private morph: { from: Map<number, Vec>; to: Map<number, Vec>; start: number; version: number } | null = null;

  constructor(
    root: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly hooks: AppHooks,
  ) {
    this.renderer = new Renderer(canvas);
    this.wheel = new Wheel(root);
    this.wheel.onClose = () => this.invalidate();
    this.menu = new ContextMenu(root, canvas);
    this.menu.onClose = () => {
      this.menuTarget = { kind: 'none' };
      this.invalidate();
    };
    this.bar = new SelectionBar(
      root,
      [
        { key: 'rotate', title: 'Rotate 90° right', icon: ICONS.rotateRight },
        { key: 'flip-h', title: 'Flip horizontal', icon: ICONS.flipH },
        { key: 'flip-v', title: 'Flip vertical', icon: ICONS.flipV },
        { key: 'duplicate', title: 'Duplicate', icon: ICONS.duplicate },
        { key: 'tidy', title: 'Clean up', icon: ICONS.tidy },
        { key: 'delete', title: 'Delete', icon: ICONS.trash, danger: true },
        { key: 'more', title: 'More options', icon: ICONS.more },
      ],
      (key, from, pointerType) => this.onBar(key, from, pointerType),
    );
    this.card = new AnalysisCard(root, (text) =>
      void copyText(text).then((ok) => this.hooks.toast(ok ? 'Analysis copied' : 'Copying was blocked; select the text and copy it yourself')),
    );
    this.theme = readTheme(document.documentElement);
    this.bind();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  /** Restore the last drawing, or open on the given example. Returns true if restored. */
  start(example: () => Molecule): boolean {
    const restored = this.restore();
    if (!restored) this.mol.load(example().toJSON());
    this.fit();
    this.hooks.onChange(this.readout());
    this.hooks.onHistory(false, false);
    return restored;
  }

  // ——— Public actions (toolbar, menus, tests) ———

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  undo(): void {
    const prev = this.history.undo(this.mol.toJSON());
    if (!prev) return;
    this.closePopups();
    this.mol.load(prev);
    this.changed();
  }

  redo(): void {
    const next = this.history.redo(this.mol.toJSON());
    if (!next) return;
    this.closePopups();
    this.mol.load(next);
    this.changed();
  }

  /**
   * Redraw molecules with ideal geometry (all of them, or the ones containing
   * `scope`), letting the atoms glide into their new places.
   */
  cleanup(scope?: number[], before: MoleculeData = this.mol.toJSON()): void {
    if (this.mol.isEmpty) return;
    const result = cleanupLayout(this.mol, scope, { lattice: this.snap });
    if (result.maxShift < 0.005 && result.stereo.size === 0) {
      this.hooks.toast(scope ? 'This molecule is already tidy' : 'Everything is already tidy');
      return;
    }
    const from = new Map([...result.positions.keys()].map((id) => [id, this.mol.pos(id)]));
    this.closePopups();
    applyCleanup(this.mol, result);
    this.history.record(before);
    this.changed();
    if (!reducedMotion()) this.morph = { from, to: result.positions, start: performance.now(), version: this.mol.version };
    this.hooks.toast(scope ? 'Molecule cleaned up' : 'Cleaned up', { label: 'Undo', run: () => this.undo() });
  }

  clear(): void {
    if (this.mol.isEmpty) return;
    this.edit(() => this.mol.load({ atoms: [], bonds: [], nextId: 1 }));
    this.hooks.toast('Canvas cleared', { label: 'Undo', run: () => this.undo() });
  }

  /** Frame the drawing in the space the floating panels leave free. */
  fit(): void {
    const box = boundsOf(this.mol.atoms.values());
    const { width, height } = this.renderer;
    const rect = this.hooks.freeArea?.() ?? { x: 24, y: 72, width: width - 48, height: height - 184 };
    rect.width = Math.max(80, rect.width);
    rect.height = Math.max(80, rect.height);
    if (!box) {
      this.view.scale = width < 640 ? 38 : 44;
      this.view.x = rect.x + rect.width / 2;
      this.view.y = rect.y + rect.height / 2;
    } else {
      this.view.fit({ minX: box.minX - 1, minY: box.minY - 1, maxX: box.maxX + 1, maxY: box.maxY + 1 }, rect, width < 640 ? 40 : 52);
    }
    this.invalidate();
  }

  zoom(factor: number): void {
    this.view.zoomAt({ x: this.renderer.width / 2, y: this.renderer.height / 2 }, factor);
    this.invalidate();
  }

  smiles(): string {
    return toSmiles(this.mol);
  }

  molfile(): string {
    return toMolfile(this.mol);
  }

  svg(): string | null {
    return toSvg(this.mol, EXPORT_COLORS);
  }

  png(): Promise<Blob | null> {
    return toPng(this.mol, EXPORT_COLORS, '#ffffff');
  }

  /**
   * Add the structure in a Molfile, centred on `at` (model space) or beside
   * the drawing. The new atoms become the selection; their ids are returned.
   */
  importMolfile(text: string, at?: Vec, verb = 'Imported'): number[] {
    let data: MoleculeData;
    try {
      data = parseMolfile(text);
    } catch (err) {
      this.hooks.toast(err instanceof Error ? err.message : 'That file could not be read.');
      return [];
    }
    return this.placeFragment(data, at, verb);
  }

  /** Re-read colours after a theme change. */
  refreshTheme(): void {
    this.theme = readTheme(document.documentElement);
    this.invalidate();
  }

  get tool(): Tool {
    return this.currentTool;
  }

  setTool(tool: Tool): void {
    if (tool === this.currentTool) return;
    this.currentTool = tool;
    this.hooks.onTool?.(tool);
    this.updateCursor();
  }

  // ——— Selection ———

  get selection(): ReadonlySet<number> {
    return this.selected;
  }

  select(ids: Iterable<number>, how: 'replace' | 'add' | 'toggle' = 'replace'): void {
    const list = [...ids].filter((id) => this.mol.atoms.has(id));
    if (how === 'replace') this.selected = new Set(list);
    else if (how === 'add' || !list.every((id) => this.selected.has(id))) list.forEach((id) => this.selected.add(id));
    else list.forEach((id) => this.selected.delete(id));
    this.selectionChanged();
  }

  selectAll(): void {
    this.select(this.mol.atoms.keys());
  }

  deselect(): void {
    if (!this.selected.size) return;
    this.selected = new Set();
    this.selectionChanged();
  }

  selectMolecule(atom: number): void {
    if (this.mol.atoms.has(atom)) this.select(this.mol.fragmentOf(atom));
  }

  deleteSelection(): void {
    if (!this.selected.size) return;
    const atoms = [...this.selected];
    this.selected = new Set();
    this.commitPlan({ kind: 'erase', atoms, bonds: [], label: '' });
  }

  /** Copy the selection (or, with nothing selected, everything) as a Molfile. */
  async copySelection(): Promise<void> {
    const atoms = this.selected.size ? [...this.selected] : [...this.mol.atoms.keys()];
    if (!atoms.length) return;
    const text = this.stash(atoms);
    const ok = await copyText(text);
    const what = this.selected.size ? countText(atoms.length) : 'the drawing';
    this.hooks.toast(ok ? `Copied ${what}` : `Copied ${what} for pasting here (the system clipboard was blocked)`);
  }

  cutSelection(): void {
    if (!this.selected.size) return;
    const n = this.selected.size;
    const text = this.stash([...this.selected]);
    this.deleteSelection();
    void copyText(text).then(() => this.hooks.toast(`Cut ${countText(n)}`, { label: 'Undo', run: () => this.undo() }));
  }

  /** Paste a copied structure or Molfile, centred on `at` (model space) if given. */
  async paste(at?: Vec): Promise<void> {
    const text = await readText();
    if (text && /M\s+END/.test(text)) this.importMolfile(text, at, 'Pasted');
    else if (this.clip) this.placeFragment(this.clip, at, 'Pasted');
    else this.hooks.toast('Nothing to paste: copy a structure or a Molfile first');
  }

  /** A copy of the selection beside it; the copy becomes the selection. */
  duplicateSelection(): void {
    if (!this.selected.size) return;
    const data = extractFragment(this.mol, this.selected);
    const box = boundsOf(data.atoms)!;
    const width = box.maxX - box.minX;
    let start = { x: width + 1.5, y: 0 };
    if (this.snap && onLattice(data)) {
      start = latticeShift(start);
      while (start.x < width + 1) start = add(start, A1);
    }
    const offset = clearOffset(this.mol, data, start, A1);
    let ids: number[] = [];
    this.edit(() => {
      ids = insertFragment(this.mol, data, offset);
      this.selected = new Set(ids);
    });
    this.reveal(ids);
  }

  /** Turn the selection about its middle; positive angles are clockwise. */
  rotateSelection(angle: number): void {
    if (this.selected.size > 1) this.edit(() => rotateAtoms(this.mol, this.selected, angle));
  }

  flipSelection(axis: FlipAxis): void {
    if (this.selected.size > 1) this.edit(() => flipAtoms(this.mol, this.selected, axis));
  }

  nudgeSelection(dx: number, dy: number): void {
    if (this.selected.size) this.edit(() => translateAtoms(this.mol, this.selected, { x: dx, y: dy }));
  }

  cleanupSelection(): void {
    if (this.selected.size) this.cleanup([...this.selected]);
  }

  async copyAs(format: 'smiles' | 'molfile' | 'svg', atoms?: Iterable<number>): Promise<void> {
    const mol = atoms ? Molecule.fromJSON(extractFragment(this.mol, atoms)) : this.mol;
    if (mol.isEmpty) {
      this.hooks.toast('Draw something first');
      return;
    }
    const text = format === 'smiles' ? toSmiles(mol) : format === 'molfile' ? toMolfile(mol) : toSvg(mol, EXPORT_COLORS);
    const name = { smiles: 'SMILES', molfile: 'Molfile', svg: 'SVG' }[format];
    this.hooks.toast(text && (await copyText(text)) ? `${name} copied` : 'Copying was blocked; try the export menu instead');
  }

  /** Formula, masses and elemental analysis of some atoms (default: the selection, or everything). */
  analysis(atoms?: Iterable<number>): Analysis {
    return analyze(this.mol, atoms ?? (this.selected.size ? this.selected : undefined));
  }

  showAnalysis(): void {
    this.card.show(null, '');
    this.refreshAnalysis();
  }

  // ——— Single-atom and single-bond edits (menus) ———

  setAtomElement(id: number, element: string): void {
    this.edit(() => setElement(this.mol, id, element));
  }

  changeCharge(id: number, delta: number): void {
    this.edit(() => adjustCharge(this.mol, id, delta));
  }

  removeAtom(id: number): void {
    this.edit(() => deleteAtom(this.mol, id));
  }

  /** Open the element wheel on an atom, optionally straight into typing a symbol. */
  editAtom(id: number, typing = false): void {
    this.openAtomWheel(id);
    if (typing) this.wheel.promptSymbol();
  }

  setBond(id: number, style: BondStyle): void {
    this.edit(() => setBondStyle(this.mol, id, style), [id]);
  }

  /** Move the narrow end of a wedge or hash to the other atom. */
  flipWedge(id: number): void {
    this.edit(() => this.mol.reverseBond(id), [id]);
  }

  removeBond(id: number): void {
    this.edit(() => deleteBond(this.mol, id));
  }

  addAtomAt(p: Vec): void {
    const pos = this.snap ? nearestLatticePoint(p) : p;
    if (nearestAtom(this.mol, pos, MERGE_DISTANCE) === null) this.edit(() => addLoneAtom(this.mol, pos));
  }

  // ——— Wiring ———

  private bind(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', this.onPointerDown);
    c.addEventListener('pointermove', this.onPointerMove);
    c.addEventListener('pointerup', this.onPointerUp);
    c.addEventListener('pointercancel', this.onPointerCancel);
    c.addEventListener('pointerleave', () => {
      this.pointer = null;
      if (this.mode.kind === 'idle' && this.hover.kind !== 'none') {
        this.hover = { kind: 'none' };
        this.invalidate();
      }
    });
    // Touches on the canvas never become mouse clicks: without this, the click a
    // browser fires after a tap lands on the element wheel that the tap just opened.
    c.addEventListener('touchend', (e) => e.cancelable && e.preventDefault(), { passive: false });
    c.addEventListener('wheel', this.onWheel, { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', (e) => {
      if (e.key === ' ') {
        this.spaceHeld = false;
        this.updateCursor();
      }
    });
    window.addEventListener('blur', () => {
      this.spaceHeld = false;
      this.cancelMode();
    });
    window.addEventListener('paste', (e) => {
      if (isEditable(e.target)) return;
      const text = e.clipboardData?.getData('text') ?? '';
      const at = this.pointer ? this.view.toModel(this.pointer) : undefined;
      if (/M\s+END/.test(text)) {
        e.preventDefault();
        this.importMolfile(text, at, 'Pasted');
      } else if (!text.trim() && this.clip) {
        this.placeFragment(this.clip, at, 'Pasted');
      } else if (text.trim()) {
        this.hooks.toast('Paste a Molfile (MOL) to import it. SMILES import is not supported yet.');
      }
    });
    new MutationObserver(() => this.refreshTheme()).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class', 'style'],
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.refreshTheme());
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.renderer.resize(rect.width, rect.height, window.devicePixelRatio || 1);
    this.invalidate();
  }

  private local(e: { clientX: number; clientY: number }): Vec {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private size(): { width: number; height: number } {
    return { width: this.renderer.width, height: this.renderer.height };
  }

  // ——— Pointer state machine ———

  private onPointerDown = (e: PointerEvent): void => {
    if (this.wheel.isOpen || this.menu.isOpen) {
      this.closePopups();
      this.swallowed.add(e.pointerId);
      this.invalidate();
      return;
    }
    const at = this.local(e);
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic events may not be capturable; moves still arrive on the canvas.
    }
    if (e.pointerType === 'pen') this.penSeen = true;
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, at);
      if (this.touches.size >= 2) {
        this.startPinch();
        return;
      }
      // With a stylus in use, a single finger pans instead of drawing (palm-friendly).
      if (this.penSeen) {
        this.mode = { kind: 'pan', pointerId: e.pointerId, last: at };
        return;
      }
    }
    if (this.mode.kind !== 'idle') return;
    // Right button, or Control-click with a mouse (the Mac's right-click).
    if (e.button === 2 || (e.button === 0 && e.ctrlKey && e.pointerType === 'mouse')) {
      this.mode = { kind: 'secondary', pointerId: e.pointerId, start: at, last: at, moved: false };
      return;
    }
    if (e.button === 1 || (this.spaceHeld && e.pointerType === 'mouse')) {
      this.mode = { kind: 'pan', pointerId: e.pointerId, last: at };
      this.updateCursor();
      return;
    }
    if (e.button !== 0) return;
    if (this.overHandle(at, e.pointerType)) {
      this.startRotate(e.pointerId, at);
      return;
    }
    const hit = this.hitTest(this.view.toModel(at), e.pointerType);
    let zone: Zone = 'draw';
    if (this.inSelection(hit, at)) zone = 'selection';
    else if (this.currentTool === 'select' || (e.shiftKey && e.pointerType === 'mouse' && hit.kind === 'none')) zone = 'select';
    const timer = window.setTimeout(() => this.onLongPress(e.pointerId), LONG_PRESS_MS);
    this.mode = {
      kind: 'pending',
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      start: at,
      points: [{ ...at, pressure: e.pressure }],
      hit,
      timer,
      zone,
      shift: e.shiftKey,
    };
    this.hover = { kind: 'none' };
    this.invalidate();
  };

  private onPointerMove = (e: PointerEvent): void => {
    const at = this.local(e);
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) this.touches.set(e.pointerId, at);
    const m = this.mode;
    switch (m.kind) {
      case 'idle':
        if (e.pointerType !== 'touch') {
          this.pointer = at;
          this.updateHover(at, e.pointerType);
          this.updateCursor();
        }
        return;
      case 'pinch':
        this.updatePinch();
        return;
      case 'pan':
        if (e.pointerId !== m.pointerId) return;
        this.view.panBy(at.x - m.last.x, at.y - m.last.y);
        m.last = at;
        this.invalidate();
        return;
      case 'secondary':
        if (e.pointerId !== m.pointerId) return;
        if (!m.moved && dist(at, m.start) < slop('mouse')) return;
        if (!m.moved) {
          m.moved = true;
          this.canvas.style.cursor = 'grabbing';
        }
        this.view.panBy(at.x - m.last.x, at.y - m.last.y);
        m.last = at;
        this.invalidate();
        return;
      case 'pending':
        if (e.pointerId !== m.pointerId) return;
        m.points.push(...this.samples(e));
        if (dist(at, m.start) > slop(m.pointerType)) {
          clearTimeout(m.timer);
          this.startDrag(m, at);
        }
        return;
      case 'held':
        if (e.pointerId !== m.pointerId || dist(at, m.start) <= slop(m.pointerType)) return;
        if (m.zone === 'selection') this.startMoveSelection(m.pointerId, m.start, at);
        else this.startMarquee(m.pointerId, [m.start, at], m.shift);
        return;
      case 'draw':
        if (e.pointerId !== m.pointerId) return;
        m.points.push(...this.samples(e));
        m.dirty = true;
        this.invalidate();
        return;
      case 'marquee':
        if (e.pointerId !== m.pointerId) return;
        m.points.push(at);
        this.updateMarquee(m);
        this.invalidate();
        return;
      case 'move-selection': {
        if (e.pointerId !== m.pointerId) return;
        const now = performance.now();
        m.trail.push({ ...at, t: now });
        if (isShake(m.trail, now)) {
          // Shaken, not moved: put it back and tidy it instead.
          this.mol.load(m.before);
          this.mode = { kind: 'idle' };
          this.swallowed.add(m.pointerId);
          vibrate([12, 40, 12]);
          this.cleanup([...this.selected], m.before);
          this.updateCursor();
          return;
        }
        const model = this.view.toModel(at);
        translateAtoms(this.mol, this.selected, sub(model, m.last));
        m.last = model;
        m.moved = true;
        this.invalidate();
        return;
      }
      case 'rotate-selection': {
        if (e.pointerId !== m.pointerId) return;
        const now = angleOf(sub(this.view.toModel(at), m.center));
        m.raw += angleDiff(now, m.prev);
        m.prev = now;
        // Snap to 15° steps when close to one.
        const step = Math.round(m.raw / deg(15)) * deg(15);
        m.angle = Math.abs(m.raw - step) < deg(4) ? step : m.raw;
        m.at = at;
        for (const [id, p] of m.origin) this.mol.updateAtom(id, rotateAbout(p, m.center, m.angle));
        this.invalidate();
        return;
      }
      case 'move-atom': {
        if (e.pointerId !== m.pointerId) return;
        if (!m.moved && dist(at, m.start) < slop(e.pointerType)) return;
        m.moved = true;
        let target = add(this.view.toModel(at), m.offset);
        const neighbors = this.mol.neighbors(m.atom);
        if (neighbors.length === 1) {
          // Swing a substituent around its anchor in 15° steps.
          const c = this.mol.pos(neighbors[0]);
          if (Math.abs(dist(target, c) - 1) < 0.3) {
            target = add(c, polar(Math.round(angleOf(sub(target, c)) / deg(15)) * deg(15), 1));
          }
        }
        m.target = nearestAtom(this.mol, target, MERGE_DISTANCE, (id) => id === m.atom || neighbors.includes(id));
        if (m.target !== null) target = this.mol.pos(m.target);
        this.mol.updateAtom(m.atom, { x: target.x, y: target.y });
        this.invalidate();
        return;
      }
      case 'move-fragment': {
        if (e.pointerId !== m.pointerId) return;
        m.trail.push({ ...at, t: performance.now() });
        if (isShake(m.trail, performance.now())) {
          this.mol.load(m.before);
          this.mode = { kind: 'idle' };
          this.swallowed.add(m.pointerId);
          vibrate([12, 40, 12]);
          this.cleanup(m.atoms, m.before);
          this.updateCursor();
          return;
        }
        if (!m.moved && dist(at, m.start) < slop(e.pointerType)) return;
        m.moved = true;
        const model = this.view.toModel(at);
        translateAtoms(this.mol, m.atoms, sub(model, m.last));
        m.last = model;
        this.invalidate();
        return;
      }
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (this.swallowed.delete(e.pointerId)) return;
    if (e.pointerType === 'touch') this.touches.delete(e.pointerId);
    const m = this.mode;
    switch (m.kind) {
      case 'pinch':
        if (this.touches.size === 0) {
          const tap = performance.now() - m.began < 320 && m.travel < 14;
          this.mode = { kind: 'idle' };
          if (tap && m.most === 2) this.undo();
          else if (tap && m.most >= 3) this.redo();
        }
        return;
      case 'pan':
        if (e.pointerId !== m.pointerId) return;
        this.mode = { kind: 'idle' };
        this.updateCursor();
        return;
      case 'secondary':
        if (e.pointerId !== m.pointerId) return;
        this.mode = { kind: 'idle' };
        if (!m.moved) this.menuAt(m.start, 'mouse');
        this.updateCursor();
        return;
      case 'pending':
        if (e.pointerId !== m.pointerId) return;
        clearTimeout(m.timer);
        this.mode = { kind: 'idle' };
        this.release(m);
        return;
      case 'held':
        if (e.pointerId !== m.pointerId) return;
        this.mode = { kind: 'idle' };
        if (m.zone === 'selection') this.openMenu({ kind: 'selection' }, m.start, m.pointerType);
        else this.openMenu({ kind: 'canvas', at: this.view.toModel(m.start) }, m.start, m.pointerType);
        return;
      case 'draw':
        if (e.pointerId === m.pointerId) this.finishStroke(m);
        return;
      case 'marquee':
        if (e.pointerId !== m.pointerId) return;
        this.mode = { kind: 'idle' };
        this.selectionChanged();
        this.updateCursor();
        return;
      case 'move-selection':
      case 'rotate-selection': {
        if (e.pointerId !== m.pointerId) return;
        this.mode = { kind: 'idle' };
        const changed = m.kind === 'move-selection' ? m.moved : Math.abs(m.angle) > 1e-9;
        if (changed) {
          this.history.record(m.before);
          this.changed();
        }
        this.updateCursor();
        this.invalidate();
        return;
      }
      case 'move-atom':
        if (e.pointerId !== m.pointerId) return;
        this.mode = { kind: 'idle' };
        if (!m.moved) {
          this.openMenu({ kind: 'atom', id: m.atom }, m.start, m.pointerType);
        } else {
          if (m.target !== null) this.mol.mergeAtom(m.atom, m.target);
          this.history.record(m.before);
          this.changed();
        }
        this.updateCursor();
        this.invalidate();
        return;
      case 'move-fragment':
        if (e.pointerId !== m.pointerId) return;
        this.mode = { kind: 'idle' };
        if (!m.moved) this.openMenu({ kind: 'bond', id: m.bond }, m.start, m.pointerType);
        else {
          this.history.record(m.before);
          this.changed();
        }
        this.updateCursor();
        this.invalidate();
        return;
    }
  };

  private onPointerCancel = (e: PointerEvent): void => {
    this.touches.delete(e.pointerId);
    this.swallowed.delete(e.pointerId);
    if (this.mode.kind === 'pinch') {
      if (this.touches.size === 0) this.mode = { kind: 'idle' };
      return;
    }
    if ('pointerId' in this.mode && this.mode.pointerId === e.pointerId) this.cancelMode();
  };

  private cancelMode(): void {
    const m = this.mode;
    if (m.kind === 'pending') clearTimeout(m.timer);
    if ((m.kind === 'move-atom' || m.kind === 'move-fragment' || m.kind === 'move-selection') && m.moved) this.mol.load(m.before);
    if (m.kind === 'rotate-selection') this.mol.load(m.before);
    this.mode = { kind: 'idle' };
    if (m.kind === 'marquee') {
      this.selected = m.base;
      this.selectionChanged();
    }
    this.updateCursor();
    this.invalidate();
  }

  private samples(e: PointerEvent): InkPoint[] {
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    return (events.length ? events : [e]).map((ev) => ({ ...this.local(ev), pressure: ev.pressure }));
  }

  /** The press has moved off its starting point: draw, select or move. */
  private startDrag(m: Extract<Mode, { kind: 'pending' }>, at: Vec): void {
    if (m.zone === 'selection') {
      this.startMoveSelection(m.pointerId, m.start, at);
    } else if (m.zone === 'select') {
      if (m.hit.kind === 'none') this.startMarquee(m.pointerId, m.points.map((p) => ({ x: p.x, y: p.y })), m.shift);
      else {
        this.selectHit(m.hit, m.shift ? 'add' : 'replace');
        this.startMoveSelection(m.pointerId, m.start, at);
      }
    } else {
      this.deselect();
      this.mode = { kind: 'draw', pointerId: m.pointerId, pointerType: m.pointerType, points: m.points, plan: NONE, dirty: true, memory: {} };
      this.wheel.close();
      this.invalidate();
    }
  }

  /** A press let go before it moved or was held. */
  private release(m: Extract<Mode, { kind: 'pending' }>): void {
    if (m.zone === 'selection') {
      if (m.hit.kind === 'none') this.deselect();
      else this.tap(m.hit, m.start);
    } else if (m.zone === 'select') {
      if (m.hit.kind !== 'none') this.selectHit(m.hit, m.shift ? 'toggle' : 'replace');
      else if (!m.shift) this.deselect();
    } else {
      this.deselect();
      this.tap(m.hit, m.start);
    }
  }

  private onLongPress(pointerId: number): void {
    const m = this.mode;
    if (m.kind !== 'pending' || m.pointerId !== pointerId) return;
    vibrate(10);
    if (m.zone === 'selection') {
      this.mode = { kind: 'held', pointerId, pointerType: m.pointerType, start: m.start, zone: 'selection', shift: m.shift };
      this.updateCursor();
      return;
    }
    if (!(m.zone === 'select' && m.shift)) this.deselect();
    const model = this.view.toModel(m.start);
    if (m.hit.kind === 'atom') {
      this.mode = {
        kind: 'move-atom',
        pointerId,
        pointerType: m.pointerType,
        atom: m.hit.id,
        offset: sub(this.mol.pos(m.hit.id), model),
        start: m.start,
        moved: false,
        before: this.mol.toJSON(),
        target: null,
      };
    } else if (m.hit.kind === 'bond') {
      const bond = this.mol.bonds.get(m.hit.id)!;
      this.mode = {
        kind: 'move-fragment',
        pointerId,
        pointerType: m.pointerType,
        atoms: this.mol.fragmentOf(bond.a),
        bond: bond.id,
        last: model,
        start: m.start,
        moved: false,
        before: this.mol.toJSON(),
        trail: [],
      };
    } else {
      this.mode = { kind: 'held', pointerId, pointerType: m.pointerType, start: m.start, zone: 'canvas', shift: m.shift };
      if (!reducedMotion()) this.pulses.push({ at: m.start, start: performance.now() });
    }
    this.updateCursor();
    this.invalidate();
  }

  private startPinch(): void {
    this.cancelMode();
    const [a, b] = [...this.touches.values()];
    this.mode = {
      kind: 'pinch',
      began: performance.now(),
      fingers: new Map(this.touches),
      most: this.touches.size,
      travel: 0,
      origin: { scale: this.view.scale, x: this.view.x, y: this.view.y, mid: midpoint(a, b), span: Math.max(dist(a, b), 1) },
    };
  }

  private updatePinch(): void {
    const m = this.mode;
    if (m.kind !== 'pinch') return;
    m.most = Math.max(m.most, this.touches.size);
    for (const [id, p] of this.touches) {
      const s = m.fingers.get(id);
      if (s) m.travel = Math.max(m.travel, dist(s, p));
    }
    const ids = [...m.fingers.keys()].filter((id) => this.touches.has(id));
    if (ids.length < 2) return;
    const a = this.touches.get(ids[0])!;
    const b = this.touches.get(ids[1])!;
    const o = m.origin;
    const anchor = { x: (o.mid.x - o.x) / o.scale, y: (o.mid.y - o.y) / o.scale };
    const mid = midpoint(a, b);
    this.view.scale = clamp((o.scale * Math.max(dist(a, b), 1)) / o.span, View.MIN, View.MAX);
    this.view.x = mid.x - anchor.x * this.view.scale;
    this.view.y = mid.y - anchor.y * this.view.scale;
    this.invalidate();
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const at = this.local(e);
    const notchy = e.deltaMode === 1 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY));
    if (e.ctrlKey || e.metaKey || notchy) {
      const step = e.deltaMode === 1 ? 0.05 : e.ctrlKey ? 0.01 : 0.002;
      this.view.zoomAt(at, Math.exp(-e.deltaY * step));
    } else {
      this.view.panBy(-e.deltaX, -e.deltaY);
    }
    this.closePopups();
    this.invalidate();
  };

  // ——— Selecting, moving and turning ———

  /** The selection frame's corners (top-left first, clockwise) in model space, with room for labels. */
  private selectionFrame(mol: Molecule = this.mol): Vec[] | null {
    const box = selectionBounds(mol, this.selected);
    if (!box) return null;
    const pad = 0.42 + 6 / this.view.scale;
    return corners({ minX: box.minX - pad, minY: box.minY - pad, maxX: box.maxX + pad, maxY: box.maxY + pad });
  }

  private screenFrame(): Vec[] | null {
    const m = this.mode;
    const frame =
      m.kind === 'rotate-selection' ? m.frame.map((p) => rotateAbout(p, m.center, m.angle)) : this.selectionFrame();
    return frame && frame.map((p) => this.view.toScreen(p));
  }

  private overHandle(at: Vec, pointerType: string): boolean {
    const frame = this.selected.size > 1 ? this.screenFrame() : null;
    return frame !== null && dist(at, frameHandle(frame).knob) <= (pointerType === 'touch' ? 22 : 12);
  }

  /** Whether a press belongs to the selection: on a selected atom or bond, or inside the frame. */
  private inSelection(hit: Hit, at: Vec): boolean {
    if (!this.selected.size) return false;
    if (hit.kind === 'atom') return this.selected.has(hit.id);
    if (hit.kind === 'bond') {
      const b = this.mol.bonds.get(hit.id)!;
      return this.selected.has(b.a) && this.selected.has(b.b);
    }
    const frame = this.screenFrame();
    return frame !== null && pointInPolygon(at, frame);
  }

  /** Select (or add, or toggle) the molecule an atom or bond belongs to. */
  private selectHit(hit: Hit, how: 'replace' | 'add' | 'toggle'): void {
    if (hit.kind === 'none') return;
    const atom = hit.kind === 'atom' ? hit.id : this.mol.bonds.get(hit.id)!.a;
    this.select(this.mol.fragmentOf(atom), how);
  }

  private startMarquee(pointerId: number, points: Vec[], additive: boolean): void {
    const m: Extract<Mode, { kind: 'marquee' }> = { kind: 'marquee', pointerId, points, lasso: false, base: additive ? new Set(this.selected) : new Set() };
    this.mode = m;
    this.wheel.close();
    this.updateMarquee(m);
    this.updateCursor();
    this.invalidate();
  }

  /** A box from the press to the pointer, until the path curls round into a lasso. */
  private updateMarquee(m: Extract<Mode, { kind: 'marquee' }>): void {
    if (!m.lasso && m.points.length > 3 && Math.abs(totalTurning(simplify(m.points, 3))) >= deg(120)) m.lasso = true;
    const picked = atomsInPolygon(this.mol, marqueeOutline(m).map((p) => this.view.toModel(p)));
    this.selected = new Set([...m.base, ...picked]);
  }

  private startMoveSelection(pointerId: number, start: Vec, at: Vec): void {
    this.wheel.close();
    const before = this.mol.toJSON();
    const model = this.view.toModel(at);
    translateAtoms(this.mol, this.selected, sub(model, this.view.toModel(start)));
    this.mode = { kind: 'move-selection', pointerId, last: model, moved: true, before, trail: [] };
    this.updateCursor();
    this.invalidate();
  }

  private startRotate(pointerId: number, at: Vec): void {
    const box = selectionBounds(this.mol, this.selected);
    const frame = this.selectionFrame();
    if (!box || !frame) return;
    const center = boxCenter(box);
    const start = angleOf(sub(this.view.toModel(at), center));
    this.mode = {
      kind: 'rotate-selection',
      pointerId,
      center,
      prev: start,
      raw: 0,
      angle: 0,
      origin: new Map([...this.selected].map((id) => [id, this.mol.pos(id)])),
      frame,
      before: this.mol.toJSON(),
      at,
    };
    this.closePopups();
    this.updateCursor();
    this.invalidate();
  }

  private onBar(key: string, from: HTMLElement, pointerType: string): void {
    switch (key) {
      case 'rotate':
        this.rotateSelection(deg(90));
        break;
      case 'flip-h':
        this.flipSelection('horizontal');
        break;
      case 'flip-v':
        this.flipSelection('vertical');
        break;
      case 'duplicate':
        this.duplicateSelection();
        break;
      case 'tidy':
        this.cleanupSelection();
        break;
      case 'delete':
        this.deleteSelection();
        break;
      case 'more': {
        const r = from.getBoundingClientRect();
        const host = this.canvas.getBoundingClientRect();
        this.openMenu({ kind: 'selection' }, { x: r.left - host.left, y: r.bottom - host.top }, pointerType);
        break;
      }
    }
  }

  /** Put the selection on the clipboard here, returning it as Molfile text for the system one. */
  private stash(atoms: number[]): string {
    this.clip = extractFragment(this.mol, atoms);
    return toMolfile(Molecule.fromJSON(this.clip));
  }

  /** Add a fragment centred on `at`, or beside the drawing; it becomes the selection. */
  private placeFragment(data: MoleculeData, at: Vec | undefined, verb: string): number[] {
    const box = boundsOf(data.atoms);
    if (!box) return [];
    const middle = boxCenter(box);
    const aligned = this.snap && onLattice(data);
    let offset: Vec;
    if (at) {
      offset = sub(at, middle);
      if (aligned) offset = latticeShift(offset);
    } else {
      const current = boundsOf(this.mol.atoms.values());
      const visible = this.view.visibleBox(this.renderer.width, this.renderer.height);
      offset = current
        ? { x: current.maxX + 2 - box.minX, y: (current.minY + current.maxY) / 2 - middle.y }
        : { x: (visible.minX + visible.maxX) / 2 - middle.x, y: (visible.minY + visible.maxY) / 2 - middle.y };
      if (aligned) offset = latticeShift(offset);
      offset = clearOffset(this.mol, data, offset, A1);
    }
    let ids: number[] = [];
    this.edit(() => {
      ids = insertFragment(this.mol, data, offset);
      this.selected = new Set(ids);
    });
    this.reveal(ids);
    this.hooks.toast(`${verb} ${countText(ids.length)}`, { label: 'Undo', run: () => this.undo() });
    return ids;
  }

  /** Zoom out to show these atoms if any are off screen. */
  private reveal(ids: number[]): void {
    const box = selectionBounds(this.mol, ids);
    const visible = this.view.visibleBox(this.renderer.width, this.renderer.height);
    if (box && (box.minX < visible.minX || box.maxX > visible.maxX || box.minY < visible.minY || box.maxY > visible.maxY)) this.fit();
  }

  private selectionChanged(): void {
    this.hooks.onChange(this.readout());
    this.refreshAnalysis();
    this.invalidate();
  }

  private refreshAnalysis(): void {
    if (!this.card.isOpen) return;
    if (this.mol.isEmpty) {
      this.card.show(null, 'Whole drawing');
      return;
    }
    const n = this.selected.size;
    const molecules = this.mol.components().length;
    const scope = n ? `Selection · ${countText(n)}` : molecules > 1 ? `Whole drawing · ${molecules} molecules` : 'Whole drawing';
    this.card.show(this.analysis(), scope);
  }

  // ——— Menus ———

  /** Right-click (or the menu key) at a point: the menu for whatever is there. */
  private menuAt(at: Vec, pointerType: string): void {
    const hit = this.hitTest(this.view.toModel(at), pointerType);
    if (this.inSelection(hit, at)) {
      this.openMenu({ kind: 'selection' }, at, pointerType);
      return;
    }
    this.deselect();
    if (hit.kind === 'atom') this.openMenu({ kind: 'atom', id: hit.id }, at, pointerType);
    else if (hit.kind === 'bond') this.openMenu({ kind: 'bond', id: hit.id }, at, pointerType);
    else this.openMenu({ kind: 'canvas', at: this.view.toModel(at) }, at, pointerType);
  }

  private openMenu(target: MenuTarget, at: Vec, pointerType: string): void {
    const spec = buildMenu(this, target);
    if (!spec) return;
    this.wheel.close();
    // Phones get a bottom sheet; a mouse gets a menu at the pointer.
    const sheet = pointerType === 'touch' || this.renderer.width < 640;
    this.menu.open(spec, at, sheet, this.size());
    this.menuTarget = target.kind === 'atom' || target.kind === 'bond' ? target : { kind: 'none' };
    this.invalidate();
  }

  private closePopups(): void {
    this.wheel.close();
    this.menu.close();
  }

  // ——— Gestures to edits ———

  private hitTest(p: Vec, pointerType: string): Hit {
    const coarse = pointerType === 'touch';
    const atom = nearestAtom(this.mol, p, this.atomRadius(pointerType));
    let bond: number | null = null;
    let bondD = Math.max(0.16, (coarse ? 14 : 7) / this.view.scale);
    for (const b of this.mol.bonds.values()) {
      const c = closestOnSegment(p, this.mol.pos(b.a), this.mol.pos(b.b));
      if (c.t > 0.08 && c.t < 0.92 && c.dist < bondD) {
        bondD = c.dist;
        bond = b.id;
      }
    }
    if (atom !== null) {
      const atomD = dist(p, this.mol.pos(atom));
      if (bond === null || atomD < 0.32 || atomD < bondD) return { kind: 'atom', id: atom };
    }
    return bond !== null ? { kind: 'bond', id: bond } : { kind: 'none' };
  }

  private atomRadius(pointerType: string): number {
    return Math.min(0.6, Math.max(0.32, (pointerType === 'touch' ? 22 : 12) / this.view.scale));
  }

  private planFor(m: DrawState): Plan {
    if (!m.dirty) return m.plan;
    const points = m.points.map((p) => this.view.toModel(p));
    const radius = this.atomRadius(m.pointerType);
    m.plan = interpret(
      this.mol,
      {
        points,
        startAtom: nearestAtom(this.mol, points[0], radius),
        endAtom: nearestAtom(this.mol, points[points.length - 1], radius),
        snap: this.snap,
      },
      m.memory,
    );
    m.dirty = false;
    return m.plan;
  }

  private finishStroke(m: DrawState): void {
    this.mode = { kind: 'idle' };
    const plan = this.planFor(m);
    this.fading = { points: m.points, tone: plan.kind === 'erase' ? 'danger' : 'trail', start: performance.now() };
    this.commitPlan(plan);
    this.invalidate();
  }

  private tap(hit: Hit, at: Vec): void {
    if (hit.kind === 'atom') {
      this.openAtomWheel(hit.id);
      return;
    }
    if (hit.kind === 'bond') {
      this.edit(() => cycleBondOrder(this.mol, hit.id), [hit.id]);
      return;
    }
    const model = this.view.toModel(at);
    const ring = ringAt(this.mol, model);
    if (ring) {
      this.commitPlan(aromatizePlan(this.mol, ring));
      return;
    }
    const now = performance.now();
    if (this.lastTap && now - this.lastTap.time < 350 && dist(this.lastTap.at, at) < 24) {
      this.lastTap = null;
      this.addAtomAt(model);
      return;
    }
    this.lastTap = { time: now, at };
  }

  /** Apply a change as one undoable step. */
  private edit(mutate: () => void, glowBonds: number[] = []): void {
    const before = this.mol.toJSON();
    const version = this.mol.version;
    mutate();
    if (this.mol.version === version) return;
    this.history.record(before);
    this.glow([], glowBonds);
    this.changed();
  }

  private commitPlan(plan: Plan): void {
    if (plan.kind === 'none') return;
    const before = this.mol.toJSON();
    const version = this.mol.version;
    if (plan.kind === 'erase') this.fadeOut(eraseClosure(this.mol, plan.atoms, plan.bonds));
    const applied = applyPlan(this.mol, plan);
    if (this.mol.version === version) return;
    this.history.record(before);
    this.glow(applied.atoms, applied.bonds);
    this.changed();
  }

  private glow(atoms: number[], bonds: number[]): void {
    if (reducedMotion() || (!atoms.length && !bonds.length)) return;
    const segments = bonds
      .map((id) => this.mol.bonds.get(id))
      .filter((b) => b !== undefined)
      .map((b) => [this.mol.pos(b.a), this.mol.pos(b.b)] as [Vec, Vec]);
    this.effects.push({ start: performance.now(), duration: 520, tone: 'accent', segments, dots: [] });
  }

  private fadeOut(doomed: { atoms: Set<number>; bonds: Set<number> }): void {
    if (reducedMotion()) return;
    const segments = [...doomed.bonds].map((id) => {
      const b = this.mol.bonds.get(id)!;
      return [this.mol.pos(b.a), this.mol.pos(b.b)] as [Vec, Vec];
    });
    const dots = [...doomed.atoms].filter((id) => this.mol.degree(id) === 0).map((id) => this.mol.pos(id));
    this.effects.push({ start: performance.now(), duration: 300, tone: 'danger', segments, dots });
  }

  private changed(): void {
    for (const id of this.selected) if (!this.mol.atoms.has(id)) this.selected.delete(id);
    this.persist();
    this.hooks.onHistory(this.history.canUndo, this.history.canRedo);
    this.selectionChanged();
  }

  private readout(): Readout {
    const scope = this.selected.size ? [...this.selected] : undefined;
    const formula = formulaOf(this.mol, scope);
    const shown = scope ? Molecule.fromJSON(extractFragment(this.mol, scope)) : this.mol;
    return {
      formula: hillOrder(formula.counts),
      charge: formula.charge,
      weight: formulaWeight(formula.counts),
      smiles: shown.isEmpty ? '' : toSmiles(shown),
      atoms: this.mol.atoms.size,
      valenceIssues: [...this.mol.atoms.keys()].filter((id) => hasValenceError(this.mol, id)).length,
      scope: scope ? 'selection' : 'all',
    };
  }

  // ——— Element wheel ———

  private openAtomWheel(id: number): void {
    const atom = this.mol.atoms.get(id);
    if (!atom) return;
    this.menu.close();
    this.wheelTarget = { kind: 'atom', id };
    this.invalidate();
    const items: WheelItem[] = [
      ...WHEEL_ELEMENTS.map((el) => ({ key: el, label: el, title: `Change to ${el}`, className: `el el-${el.toLowerCase()}` })),
      { key: '+', label: '+', title: 'Add positive charge', className: 'charge' },
      { key: '-', label: '−', title: 'Add negative charge', className: 'charge' },
      { key: 'more', label: '…', title: 'Type another element', className: 'more' },
      { key: 'delete', icon: ICONS.trash, title: 'Delete atom', className: 'danger' },
    ];
    this.wheel.open(
      this.view.toScreen(atom),
      {
        center: atom.element + chargeText(atom.charge),
        centerClass: `el el-${atom.element.toLowerCase()}`,
        items,
        onPick: (key) => {
          if (key === '+' || key === '-') this.changeCharge(id, key === '+' ? 1 : -1);
          else if (key === 'delete') this.removeAtom(id);
          else this.setAtomElement(id, key);
        },
        onType: (text) => {
          const el = normalizeSymbol(text);
          if (!el) return false;
          this.setAtomElement(id, el);
          return true;
        },
      },
      this.size(),
    );
  }

  // ——— Keyboard ———

  private onKeyDown = (e: KeyboardEvent): void => {
    if (isEditable(e.target)) return;
    if (this.menu.isOpen) {
      if (this.menu.handleKey(e)) e.preventDefault();
      return;
    }
    if (this.wheel.handleKey(e)) {
      e.preventDefault();
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    const sel = this.selected.size > 0;
    if (mod && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && key === 'y') {
      e.preventDefault();
      this.redo();
      return;
    }
    if (mod && e.shiftKey && key === 'k') {
      e.preventDefault();
      this.cleanup();
      return;
    }
    if (mod && key === 'a') {
      e.preventDefault();
      this.selectAll();
      return;
    }
    // Leave Copy alone when the reader has selected some page text (the SMILES, say).
    if (mod && key === 'c' && (sel || !window.getSelection()?.toString())) {
      if (this.mol.isEmpty) return;
      e.preventDefault();
      void this.copySelection();
      return;
    }
    if (mod && key === 'x' && sel) {
      e.preventDefault();
      this.cutSelection();
      return;
    }
    if (mod && key === 'd') {
      e.preventDefault();
      this.duplicateSelection();
      return;
    }
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      this.keyboardMenu();
      return;
    }
    if (mod || e.altKey) return;
    if (e.key === ' ' && (e.target === document.body || e.target === this.canvas)) {
      e.preventDefault();
      this.spaceHeld = true;
      this.updateCursor();
      return;
    }
    if (e.key === 'Escape') {
      if (this.mode.kind !== 'idle') this.cancelMode();
      else if (sel) this.deselect();
      else this.setTool('draw');
      return;
    }
    if (key === 'v') {
      this.setTool(this.currentTool === 'select' ? 'draw' : 'select');
      return;
    }
    const target = this.hover;
    if (key === 't') {
      // Tidy the selection, the molecule under the pointer, or everything.
      const anchor = target.kind === 'atom' ? target.id : target.kind === 'bond' ? this.mol.bonds.get(target.id)?.a : undefined;
      this.cleanup(sel ? [...this.selected] : anchor !== undefined ? this.mol.fragmentOf(anchor) : undefined);
      e.preventDefault();
      return;
    }
    if (sel) {
      const nudge: Record<string, Vec> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };
      const step = e.shiftKey ? 1 : 0.25;
      let handled = true;
      if (nudge[e.key]) this.nudgeSelection(nudge[e.key].x * step, nudge[e.key].y * step);
      else if (e.key === '[' || e.key === ']') this.rotateSelection(deg(e.key === ']' ? 15 : -15));
      else if (e.key === 'Delete' || e.key === 'Backspace') this.deleteSelection();
      else handled = false;
      if (handled) {
        e.preventDefault();
        return;
      }
    }
    if (target.kind === 'atom') {
      const id = target.id;
      if (ATOM_KEYS[key]) this.setAtomElement(id, ATOM_KEYS[key]);
      else if (e.key === '+' || e.key === '=') this.changeCharge(id, 1);
      else if (e.key === '-') this.changeCharge(id, -1);
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        this.removeAtom(id);
        this.hover = { kind: 'none' };
      } else return;
      e.preventDefault();
      return;
    }
    if (target.kind === 'bond') {
      const id = target.id;
      const style: Record<string, BondStyle> = { '1': 'single', '2': 'double', '3': 'triple', w: 'wedge', h: 'hash' };
      if (style[key]) this.setBond(id, style[key]);
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        this.removeBond(id);
        this.hover = { kind: 'none' };
      } else return;
      e.preventDefault();
      return;
    }
    if (e.key === '0') this.fit();
  };

  /** The menu key (or Shift F10): the menu for the selection, or for what's under the pointer. */
  private keyboardMenu(): void {
    const frame = this.selected.size ? this.screenFrame() : null;
    if (frame) {
      const box = boundsOf(frame)!;
      this.openMenu({ kind: 'selection' }, { x: box.minX, y: box.maxY }, 'mouse');
      return;
    }
    this.menuAt(this.pointer ?? { x: this.renderer.width / 2, y: this.renderer.height / 2 }, 'mouse');
  }

  private updateHover(at: Vec, pointerType: string): void {
    const hit = this.hitTest(this.view.toModel(at), pointerType);
    const same = hit.kind === this.hover.kind && (hit.kind === 'none' || (this.hover.kind !== 'none' && hit.id === this.hover.id));
    if (same) return;
    this.hover = hit;
    this.invalidate();
  }

  private updateCursor(): void {
    const m = this.mode;
    let cursor = this.currentTool === 'select' ? 'default' : 'crosshair';
    if (m.kind === 'pan' || m.kind === 'move-atom' || m.kind === 'move-fragment' || m.kind === 'move-selection' || m.kind === 'rotate-selection') {
      cursor = 'grabbing';
    } else if (m.kind === 'marquee') cursor = 'crosshair';
    else if (this.spaceHeld) cursor = 'grab';
    else if (m.kind === 'idle' && this.pointer) {
      if (this.overHandle(this.pointer, 'mouse')) cursor = 'grab';
      else if (this.inSelection(this.hover, this.pointer)) cursor = 'move';
      else if (this.hover.kind !== 'none') cursor = 'pointer';
    }
    if (this.canvas.style.cursor !== cursor) this.canvas.style.cursor = cursor;
  }

  // ——— Rendering ———

  private invalidate(): void {
    if (!this.frame) this.frame = requestAnimationFrame(this.draw);
  }

  private draw = (now: number): void => {
    this.frame = 0;
    this.renderer.render(this.scene(now), this.view, this.theme);
    this.placeBar();
    if (this.effects.length || this.fading || this.morph || this.pulses.length) this.invalidate();
  };

  /** Keep the selection's toolbar under the selection while nothing is being dragged. */
  private placeBar(): void {
    const frame = this.mode.kind === 'idle' && this.selected.size ? this.screenFrame() : null;
    if (!frame) {
      this.bar.hide();
      return;
    }
    const { width, height } = this.renderer;
    const free = this.hooks.freeArea?.();
    // Keep clear of the top bar and the readout, but not of a side panel.
    const area = free ? { minX: 8, minY: free.y, maxX: width - 8, maxY: free.y + free.height } : { minX: 8, minY: 8, maxX: width - 8, maxY: height - 8 };
    this.bar.show(boundsOf(frame)!, this.selected.size > 1 ? HANDLE_GAP + 8 : 0, area);
  }

  private scene(now: number): Scene {
    const none = () => ({ atoms: new Set<number>(), bonds: new Set<number>() });
    const scene: Scene = {
      mol: this.mol,
      accent: none(),
      danger: none(),
      targets: [],
      hover: null,
      lifted: null,
      ink: [],
      pill: null,
      effects: [],
      selection: null,
      frame: null,
      marquee: null,
      pulses: [],
      now,
    };
    const m = this.mode;
    if (this.morph) {
      const t = (now - this.morph.start) / 380;
      if (t >= 1 || this.mol.version !== this.morph.version || m.kind !== 'idle') this.morph = null;
      else {
        const k = 1 - (1 - t) ** 3;
        const shown = this.mol.clone();
        for (const [id, to] of this.morph.to) {
          const from = this.morph.from.get(id);
          if (from && shown.atoms.has(id)) shown.updateAtom(id, lerp(from, to, k));
        }
        scene.mol = shown;
      }
    }
    if (m.kind === 'draw') {
      const plan = this.planFor(m);
      if (plan.kind === 'build' || plan.kind === 'bond-orders') {
        const preview = this.mol.clone();
        const applied = applyPlan(preview, plan);
        scene.mol = preview;
        scene.accent = { atoms: new Set(applied.atoms), bonds: new Set(applied.bonds) };
        if (plan.kind === 'build') {
          const start = nearestAtom(this.mol, this.view.toModel(m.points[0]), this.atomRadius(m.pointerType));
          for (const node of plan.nodes) if (node.id !== undefined && node.id !== start) scene.targets.push(node.pos);
        }
      } else if (plan.kind === 'erase') {
        scene.danger = eraseClosure(this.mol, plan.atoms, plan.bonds);
      }
      scene.ink.push({ points: m.points, tone: plan.kind === 'erase' ? 'danger' : 'trail', alpha: 1 });
      if (plan.kind !== 'none') {
        scene.pill = { text: plan.label, at: m.points[m.points.length - 1], tone: plan.kind === 'erase' ? 'danger' : 'accent' };
      }
    }
    if (this.fading) {
      const t = (now - this.fading.start) / 260;
      if (t >= 1 || reducedMotion()) this.fading = null;
      else scene.ink.push({ points: this.fading.points, tone: this.fading.tone, alpha: 1 - t });
    }
    this.effects = this.effects.filter((fx) => now - fx.start < fx.duration);
    scene.effects = this.effects;
    this.pulses = this.pulses.filter((p) => now - p.start < 360);
    scene.pulses = this.pulses.map((p) => ({ at: p.at, t: (now - p.start) / 360 }));
    if (m.kind === 'move-atom') {
      scene.lifted = new Set([m.atom]);
      if (m.target !== null) scene.targets.push(this.mol.pos(m.target));
    }
    if (m.kind === 'move-fragment') scene.lifted = new Set(m.atoms);
    if (this.selected.size) {
      const atoms = new Set([...this.selected].filter((id) => scene.mol.atoms.has(id)));
      const bonds = new Set([...scene.mol.bonds.values()].filter((b) => atoms.has(b.a) && atoms.has(b.b)).map((b) => b.id));
      scene.selection = { atoms, bonds };
      if (m.kind !== 'marquee') {
        const frame = m.kind === 'rotate-selection' ? this.screenFrame() : this.selectionFrame(scene.mol)?.map((p) => this.view.toScreen(p));
        if (frame) scene.frame = { corners: frame, handle: this.selected.size > 1 };
      }
    }
    if (m.kind === 'marquee') scene.marquee = { points: marqueeOutline(m), lasso: m.lasso };
    if (m.kind === 'rotate-selection') {
      const degrees = Math.round((m.angle * 180) / Math.PI);
      scene.pill = { text: `${degrees}°`, at: m.at, tone: 'accent' };
    }
    const focus = this.wheel.isOpen ? this.wheelTarget : this.menu.isOpen ? this.menuTarget : m.kind === 'idle' ? this.hover : null;
    if (focus && focus.kind !== 'none') {
      const exists = focus.kind === 'atom' ? this.mol.atoms.has(focus.id) : this.mol.bonds.has(focus.id);
      if (exists) scene.hover = focus;
    }
    return scene;
  }

  // ——— Persistence ———

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.mol.toJSON()));
    } catch {
      // Storage can be unavailable (private mode, sandboxed previews); drawing still works.
    }
  }

  private restore(): boolean {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw) as MoleculeData;
      if (!Array.isArray(data.atoms) || !Array.isArray(data.bonds)) return false;
      this.mol.load(data);
      return true;
    } catch {
      return false;
    }
  }
}

/** A quick back-and-forth: three or more sharp reversals within the last 0.7 s. */
function isShake(trail: Trail, now: number): boolean {
  const pts: Vec[] = [];
  for (const p of trail) {
    if (now - p.t > 700) continue;
    if (!pts.length || dist(p, pts[pts.length - 1]) >= 12) pts.push(p);
  }
  let reversals = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const turn = Math.abs(angleDiff(angleOf(sub(pts[i + 1], pts[i])), angleOf(sub(pts[i], pts[i - 1]))));
    if (turn > deg(120)) reversals++;
  }
  return reversals >= 3;
}

const corners = (b: Box): Vec[] => [
  { x: b.minX, y: b.minY },
  { x: b.maxX, y: b.minY },
  { x: b.maxX, y: b.maxY },
  { x: b.minX, y: b.maxY },
];

/** The marquee's outline in screen points: the lasso path, or the box from the press to the pointer. */
function marqueeOutline(m: { points: Vec[]; lasso: boolean }): Vec[] {
  if (m.lasso) return m.points;
  const a = m.points[0];
  const b = m.points[m.points.length - 1];
  return corners({ minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) });
}

/** Whether every atom sits on the hex paper (copies can then be kept on it). */
function onLattice(data: MoleculeData): boolean {
  return data.atoms.every((a) => dist(nearestLatticePoint(a), a) < 1e-3);
}

function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}
