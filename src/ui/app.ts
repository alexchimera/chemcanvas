import { chargeText, formulaOf, hasValenceError, hillOrder, molecularWeight } from '../core/chemistry';
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
import { add, angleOf, boundsOf, clamp, closestOnSegment, deg, dist, midpoint, polar, sub, type Vec } from '../core/geometry';
import { History } from '../core/history';
import { Molecule, type MoleculeData } from '../core/molecule';
import { nearestLatticePoint } from '../core/placement';
import { ringAt } from '../core/rings';
import { interpret, type StrokeMemory } from '../gestures/interpret';
import { applyPlan, eraseClosure, MERGE_DISTANCE, nearestAtom, NONE, type Plan } from '../gestures/plan';
import { aromatizePlan } from '../gestures/ring';
import { parseMolfile, toMolfile } from '../io/molfile';
import { toSmiles } from '../io/smiles';
import { toPng, toSvg } from '../render/export';
import { EXPORT_COLORS, readTheme, type Theme } from '../render/theme';
import { ICONS } from './icons';
import { Renderer, type Effect, type InkPoint, type Scene } from './renderer';
import { View } from './view';
import { Wheel, type WheelItem } from './wheel';

type Hit = { kind: 'atom'; id: number } | { kind: 'bond'; id: number } | { kind: 'none' };

interface DrawState {
  kind: 'draw';
  pointerId: number;
  pointerType: string;
  points: InkPoint[];
  plan: Plan;
  dirty: boolean;
  memory: StrokeMemory;
}

type Mode =
  | { kind: 'idle' }
  | { kind: 'pending'; pointerId: number; pointerType: string; start: Vec; points: InkPoint[]; hit: Hit; timer: number }
  | DrawState
  | { kind: 'move-atom'; pointerId: number; atom: number; offset: Vec; start: Vec; moved: boolean; before: MoleculeData; target: number | null }
  | { kind: 'move-fragment'; pointerId: number; atoms: number[]; bond: number; last: Vec; start: Vec; moved: boolean; before: MoleculeData }
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
}

export interface AppHooks {
  onChange(readout: Readout): void;
  onHistory(canUndo: boolean, canRedo: boolean): void;
  toast(message: string, action?: { label: string; run: () => void }): void;
  /** The part of the canvas not covered by floating panels, for framing the drawing. */
  freeArea?(): { x: number; y: number; width: number; height: number };
}

const LONG_PRESS_MS = 420;
const STORAGE_KEY = 'chemcanvas:v1:molecule';
const ATOM_KEYS: Record<string, string> = { c: 'C', n: 'N', o: 'O', s: 'S', p: 'P', f: 'F', l: 'Cl', b: 'Br', i: 'I', h: 'H' };
const WHEEL_ELEMENTS = ['O', 'N', 'S', 'F', 'Cl', 'Br', 'I', 'P', 'H', 'C'];

const slop = (pointerType: string) => (pointerType === 'touch' ? 10 : 6);
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export class ChemCanvasApp {
  readonly mol = new Molecule();
  /** Snap new structures onto the hex lattice. */
  snap = true;
  private readonly history = new History<MoleculeData>();
  private readonly view = new View();
  private readonly renderer: Renderer;
  private readonly wheel: Wheel;
  private theme: Theme;
  private mode: Mode = { kind: 'idle' };
  private hover: Hit = { kind: 'none' };
  private readonly touches = new Map<number, Vec>();
  private readonly swallowed = new Set<number>();
  private penSeen = false;
  private spaceHeld = false;
  private frame = 0;
  private effects: Effect[] = [];
  private fading: { points: InkPoint[]; tone: 'trail' | 'danger'; start: number } | null = null;
  private lastTap: { time: number; at: Vec } | null = null;
  /** What the open wheel edits, highlighted on the canvas (the wheel may sit off to one side). */
  private wheelTarget: Hit = { kind: 'none' };

  constructor(
    root: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly hooks: AppHooks,
  ) {
    this.renderer = new Renderer(canvas);
    this.wheel = new Wheel(root);
    this.wheel.onClose = () => this.invalidate();
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

  undo(): void {
    const prev = this.history.undo(this.mol.toJSON());
    if (!prev) return;
    this.wheel.close();
    this.mol.load(prev);
    this.changed();
  }

  redo(): void {
    const next = this.history.redo(this.mol.toJSON());
    if (!next) return;
    this.wheel.close();
    this.mol.load(next);
    this.changed();
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

  importMolfile(text: string): void {
    let incoming: Molecule;
    try {
      incoming = Molecule.fromJSON(parseMolfile(text));
    } catch (err) {
      this.hooks.toast(err instanceof Error ? err.message : 'That file could not be read.');
      return;
    }
    const box = boundsOf(incoming.atoms.values());
    if (!box) return;
    const current = boundsOf(this.mol.atoms.values());
    const visible = this.view.visibleBox(this.renderer.width, this.renderer.height);
    const anchor = current
      ? { x: current.maxX + 2 - box.minX, y: (current.minY + current.maxY) / 2 - (box.minY + box.maxY) / 2 }
      : { x: (visible.minX + visible.maxX) / 2 - (box.minX + box.maxX) / 2, y: (visible.minY + visible.maxY) / 2 - (box.minY + box.maxY) / 2 };
    this.edit(() => {
      const ids = new Map<number, number>();
      for (const a of incoming.atoms.values()) ids.set(a.id, this.mol.addAtom(add(a, anchor), a.element, a.charge).id);
      for (const b of incoming.bonds.values()) this.mol.addBond(ids.get(b.a)!, ids.get(b.b)!, b.order, b.stereo);
    });
    this.fit();
    this.hooks.toast(`Imported ${incoming.atoms.size} atoms`);
  }

  /** Re-read colours after a theme change. */
  refreshTheme(): void {
    this.theme = readTheme(document.documentElement);
    this.invalidate();
  }

  // ——— Wiring ———

  private bind(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', this.onPointerDown);
    c.addEventListener('pointermove', this.onPointerMove);
    c.addEventListener('pointerup', this.onPointerUp);
    c.addEventListener('pointercancel', this.onPointerCancel);
    c.addEventListener('pointerleave', () => {
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
      if (/M\s+END/.test(text)) {
        e.preventDefault();
        this.importMolfile(text);
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
    if (this.wheel.isOpen) {
      this.wheel.close();
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
    if (e.button === 1 || e.button === 2 || (this.spaceHeld && e.pointerType === 'mouse')) {
      this.mode = { kind: 'pan', pointerId: e.pointerId, last: at };
      this.updateCursor();
      return;
    }
    if (e.button !== 0) return;
    const hit = this.hitTest(this.view.toModel(at), e.pointerType);
    const timer = window.setTimeout(() => this.onLongPress(e.pointerId), LONG_PRESS_MS);
    this.mode = {
      kind: 'pending',
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      start: at,
      points: [{ ...at, pressure: e.pressure }],
      hit,
      timer,
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
        if (e.pointerType !== 'touch') this.updateHover(at, e.pointerType);
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
      case 'pending':
        if (e.pointerId !== m.pointerId) return;
        m.points.push(...this.samples(e));
        if (dist(at, m.start) > slop(m.pointerType)) {
          clearTimeout(m.timer);
          this.mode = { kind: 'draw', pointerId: m.pointerId, pointerType: m.pointerType, points: m.points, plan: NONE, dirty: true, memory: {} };
          this.wheel.close();
          this.invalidate();
        }
        return;
      case 'draw':
        if (e.pointerId !== m.pointerId) return;
        m.points.push(...this.samples(e));
        m.dirty = true;
        this.invalidate();
        return;
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
      case 'pending':
        if (e.pointerId !== m.pointerId) return;
        clearTimeout(m.timer);
        this.mode = { kind: 'idle' };
        this.tap(m.hit, m.start);
        return;
      case 'draw':
        if (e.pointerId === m.pointerId) this.finishStroke(m);
        return;
      case 'move-atom':
        if (e.pointerId !== m.pointerId) return;
        this.mode = { kind: 'idle' };
        if (!m.moved) {
          this.openAtomWheel(m.atom);
        } else {
          if (m.target !== null) this.mol.mergeAtom(m.atom, m.target);
          this.history.record(m.before);
          this.changed();
        }
        this.invalidate();
        return;
      case 'move-fragment':
        if (e.pointerId !== m.pointerId) return;
        this.mode = { kind: 'idle' };
        if (!m.moved) this.openBondWheel(m.bond);
        else {
          this.history.record(m.before);
          this.changed();
        }
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
    if ((m.kind === 'move-atom' || m.kind === 'move-fragment') && m.moved) this.mol.load(m.before);
    this.mode = { kind: 'idle' };
    this.updateCursor();
    this.invalidate();
  }

  private samples(e: PointerEvent): InkPoint[] {
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    return (events.length ? events : [e]).map((ev) => ({ ...this.local(ev), pressure: ev.pressure }));
  }

  private onLongPress(pointerId: number): void {
    const m = this.mode;
    if (m.kind !== 'pending' || m.pointerId !== pointerId) return;
    try {
      navigator.vibrate?.(10);
    } catch {
      // Vibration is optional.
    }
    const model = this.view.toModel(m.start);
    if (m.hit.kind === 'atom') {
      this.mode = {
        kind: 'move-atom',
        pointerId,
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
        atoms: this.mol.fragmentOf(bond.a),
        bond: bond.id,
        last: model,
        start: m.start,
        moved: false,
        before: this.mol.toJSON(),
      };
    } else {
      this.mode = { kind: 'pan', pointerId, last: m.start };
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
    this.wheel.close();
    this.invalidate();
  };

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
      const pos = this.snap ? nearestLatticePoint(model) : model;
      if (nearestAtom(this.mol, pos, MERGE_DISTANCE) === null) this.edit(() => addLoneAtom(this.mol, pos));
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
    this.persist();
    this.hooks.onHistory(this.history.canUndo, this.history.canRedo);
    this.hooks.onChange(this.readout());
    this.invalidate();
  }

  private readout(): Readout {
    const formula = formulaOf(this.mol);
    return {
      formula: hillOrder(formula.counts),
      charge: formula.charge,
      weight: molecularWeight(this.mol),
      smiles: this.mol.isEmpty ? '' : toSmiles(this.mol),
      atoms: this.mol.atoms.size,
      valenceIssues: [...this.mol.atoms.keys()].filter((id) => hasValenceError(this.mol, id)).length,
    };
  }

  // ——— Context wheels ———

  private openAtomWheel(id: number): void {
    const atom = this.mol.atoms.get(id);
    if (!atom) return;
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
          if (key === '+' || key === '-') this.edit(() => adjustCharge(this.mol, id, key === '+' ? 1 : -1));
          else if (key === 'delete') this.edit(() => deleteAtom(this.mol, id));
          else this.edit(() => setElement(this.mol, id, key));
        },
        onType: (text) => {
          const el = normalizeSymbol(text);
          if (!el) return false;
          this.edit(() => setElement(this.mol, id, el));
          return true;
        },
      },
      this.size(),
    );
  }

  private openBondWheel(id: number): void {
    const bond = this.mol.bonds.get(id);
    if (!bond) return;
    this.wheelTarget = { kind: 'bond', id };
    this.invalidate();
    const styles: [BondStyle, string][] = [
      ['single', 'Single bond'],
      ['double', 'Double bond'],
      ['triple', 'Triple bond'],
      ['wedge', 'Wedge (towards viewer); choose again to flip'],
      ['hash', 'Hashed wedge (away from viewer)'],
      ['wavy', 'Wavy (unknown stereo)'],
    ];
    const items: WheelItem[] = styles.map(([key, title]) => ({ key, title, icon: ICONS[key] }));
    items.push({ key: 'delete', title: 'Delete bond', icon: ICONS.trash, className: 'danger' });
    this.wheel.open(
      this.view.toScreen(midpoint(this.mol.pos(bond.a), this.mol.pos(bond.b))),
      {
        center: '',
        centerClass: 'bond-hub',
        items,
        onPick: (key) => {
          if (key === 'delete') this.edit(() => deleteBond(this.mol, id));
          else this.edit(() => setBondStyle(this.mol, id, key as BondStyle), [id]);
        },
      },
      this.size(),
    );
  }

  // ——— Keyboard ———

  private onKeyDown = (e: KeyboardEvent): void => {
    if (isEditable(e.target)) return;
    if (this.wheel.handleKey(e)) {
      e.preventDefault();
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
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
    if (mod || e.altKey) return;
    if (e.key === ' ' && (e.target === document.body || e.target === this.canvas)) {
      e.preventDefault();
      this.spaceHeld = true;
      this.updateCursor();
      return;
    }
    if (e.key === 'Escape') {
      this.cancelMode();
      return;
    }
    const target = this.hover;
    if (target.kind === 'atom') {
      const id = target.id;
      if (ATOM_KEYS[key]) this.edit(() => setElement(this.mol, id, ATOM_KEYS[key]));
      else if (e.key === '+' || e.key === '=') this.edit(() => adjustCharge(this.mol, id, 1));
      else if (e.key === '-') this.edit(() => adjustCharge(this.mol, id, -1));
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        this.edit(() => deleteAtom(this.mol, id));
        this.hover = { kind: 'none' };
      } else return;
      e.preventDefault();
      return;
    }
    if (target.kind === 'bond') {
      const id = target.id;
      const style: Record<string, BondStyle> = { '1': 'single', '2': 'double', '3': 'triple', w: 'wedge', h: 'hash' };
      if (style[key]) this.edit(() => setBondStyle(this.mol, id, style[key]), [id]);
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        this.edit(() => deleteBond(this.mol, id));
        this.hover = { kind: 'none' };
      } else return;
      e.preventDefault();
      return;
    }
    if (e.key === '0') this.fit();
  };

  private updateHover(at: Vec, pointerType: string): void {
    const hit = this.hitTest(this.view.toModel(at), pointerType);
    const same = hit.kind === this.hover.kind && (hit.kind === 'none' || (this.hover.kind !== 'none' && hit.id === this.hover.id));
    if (same) return;
    this.hover = hit;
    this.updateCursor();
    this.invalidate();
  }

  private updateCursor(): void {
    const m = this.mode;
    let cursor = 'crosshair';
    if (m.kind === 'pan') cursor = 'grabbing';
    else if (m.kind === 'move-atom' || m.kind === 'move-fragment') cursor = 'grabbing';
    else if (this.spaceHeld) cursor = 'grab';
    else if (m.kind === 'idle' && this.hover.kind !== 'none') cursor = 'pointer';
    this.canvas.style.cursor = cursor;
  }

  // ——— Rendering ———

  private invalidate(): void {
    if (!this.frame) this.frame = requestAnimationFrame(this.draw);
  }

  private draw = (now: number): void => {
    this.frame = 0;
    this.renderer.render(this.scene(now), this.view, this.theme);
    if (this.effects.length || this.fading) this.invalidate();
  };

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
      now,
    };
    const m = this.mode;
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
    if (m.kind === 'move-atom') {
      scene.lifted = new Set([m.atom]);
      if (m.target !== null) scene.targets.push(this.mol.pos(m.target));
    }
    if (m.kind === 'move-fragment') scene.lifted = new Set(m.atoms);
    const focus = this.wheel.isOpen ? this.wheelTarget : m.kind === 'idle' ? this.hover : null;
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

function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}
