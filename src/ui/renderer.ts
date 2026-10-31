import { add, clamp, lerp, meanPoint, midpoint, normalize, scale, sub, TAU, type Vec } from '../core/geometry';
import type { Molecule } from '../core/molecule';
import { forEachLatticePoint } from '../core/placement';
import { depict, STYLE } from '../render/depict';
import { CanvasPainter } from '../render/painter';
import type { Theme } from '../render/theme';
import type { View } from './view';

/** A raw pointer sample in CSS pixels. */
export interface InkPoint {
  x: number;
  y: number;
  pressure: number;
}

/** A short-lived flourish: new bonds glowing in, erased bonds shrinking away. */
export interface Effect {
  start: number;
  duration: number;
  tone: 'accent' | 'danger';
  segments: [Vec, Vec][];
  dots: Vec[];
}

export interface Highlight {
  atoms: Set<number>;
  bonds: Set<number>;
}

export interface Scene {
  mol: Molecule;
  accent: Highlight;
  danger: Highlight;
  /** Existing atoms the current stroke will connect to. */
  targets: Vec[];
  hover: { kind: 'atom' | 'bond'; id: number } | null;
  lifted: Set<number> | null;
  ink: { points: InkPoint[]; tone: 'trail' | 'danger'; alpha: number }[];
  pill: { text: string; at: Vec; tone: 'accent' | 'danger' } | null;
  effects: Effect[];
  /** Selected atoms and bonds (or what a marquee would select). */
  selection: Highlight | null;
  /** The selection frame's corners in screen px, top-left first, and whether it has a rotate handle. */
  frame: { corners: Vec[]; handle: boolean } | null;
  /** A box or lasso being dragged out, in screen px. */
  marquee: { points: Vec[]; lasso: boolean } | null;
  /** Ripples where a press turned into a hold (screen px, t from 0 to 1). */
  pulses: { at: Vec; t: number }[];
  now: number;
}

/** Distance (px) from the top edge of the selection frame to its rotate handle. */
export const HANDLE_GAP = 26;

/** Where the rotate handle sits on a (possibly turned) selection frame. */
export function frameHandle(corners: readonly Vec[]): { base: Vec; knob: Vec } {
  const base = midpoint(corners[0], corners[1]);
  const up = normalize(sub(base, meanPoint(corners)));
  return { base, knob: add(base, scale(up, HANDLE_GAP)) };
}

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  /** Scratch layer for highlights, so overlapping halos don't build up darker spots. */
  private layer: HTMLCanvasElement | null = null;
  width = 0;
  height = 0;
  dpr = 1;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  resize(width: number, height: number, dpr: number): void {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
  }

  render(scene: Scene, view: View, theme: Theme): void {
    const { ctx, dpr } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = theme.paper;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.drawLattice(view, theme);

    const p = new CanvasPainter(ctx, view.scale * dpr, view.x * dpr, view.y * dpr);
    const { mol } = scene;
    const tint = (h: Highlight, kind: 'atoms' | 'bonds', id: number) =>
      scene.danger[kind].has(id) ? theme.danger : h[kind].has(id) ? theme.accent : undefined;
    depict(p, mol, theme, {
      atomColor: (id) => tint(scene.accent, 'atoms', id),
      bondColor: (id) => tint(scene.accent, 'bonds', id),
      showValenceErrors: true,
      knockout: theme.paper,
    });

    p.alpha = 0.14;
    if (scene.hover?.kind === 'atom' && mol.atoms.has(scene.hover.id)) p.circle(mol.pos(scene.hover.id), 0.36, theme.accent);
    if (scene.hover?.kind === 'bond') {
      const b = mol.bonds.get(scene.hover.id);
      if (b) p.line(mol.pos(b.a), mol.pos(b.b), 0.32, theme.accent);
    }
    if (scene.lifted) {
      p.alpha = 0.16;
      for (const id of scene.lifted) if (mol.atoms.has(id)) p.circle(mol.pos(id), 0.42, theme.accent);
    }
    p.alpha = 1;
    if (scene.selection) this.drawHalo(view, mol, scene.selection, theme.accent, 0.2);

    for (const t of scene.targets) p.circle(t, 0.3, null, theme.accent, 0.05);

    for (const fx of scene.effects) {
      const t = clamp((scene.now - fx.start) / fx.duration, 0, 1);
      if (fx.tone === 'accent') {
        p.alpha = (1 - t) ** 2;
        for (const [a, b] of fx.segments) p.line(a, b, STYLE.lineWidth * (1 + 2 * (1 - t)), theme.accent);
      } else {
        p.alpha = 1 - t;
        for (const [a, b] of fx.segments) {
          const m = midpoint(a, b);
          p.line(lerp(a, m, t * 0.7), lerp(b, m, t * 0.7), STYLE.lineWidth * 1.3, theme.danger);
        }
        for (const d of fx.dots) p.circle(d, 0.1 * (1 - t), theme.danger);
      }
    }
    p.alpha = 1;

    // The painter leaves the context at whatever opacity it last used.
    ctx.globalAlpha = 1;
    if (scene.frame) this.drawFrame(scene.frame.corners, scene.frame.handle, theme);
    if (scene.marquee) this.drawMarquee(scene.marquee.points, scene.marquee.lasso, theme);
    for (const pulse of scene.pulses) this.drawPulse(pulse.at, pulse.t, theme);

    for (const stroke of scene.ink) {
      this.drawInk(stroke.points, stroke.tone === 'danger' ? theme.danger : theme.trail, stroke.alpha);
    }
    if (scene.pill) this.drawPill(scene.pill.text, scene.pill.at, scene.pill.tone === 'danger' ? theme.danger : theme.accent, theme);
  }

  /** A flat highlighter band over atoms and bonds, drawn opaque on a layer and laid on translucent. */
  private drawHalo(view: View, mol: Molecule, h: Highlight, color: string, alpha: number): void {
    const { ctx, canvas } = this;
    const layer = (this.layer ??= document.createElement('canvas'));
    if (layer.width !== canvas.width || layer.height !== canvas.height) {
      layer.width = canvas.width;
      layer.height = canvas.height;
    }
    const lc = layer.getContext('2d')!;
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.globalAlpha = 1;
    lc.clearRect(0, 0, layer.width, layer.height);
    const p = new CanvasPainter(lc, view.scale * this.dpr, view.x * this.dpr, view.y * this.dpr);
    for (const id of h.bonds) {
      const b = mol.bonds.get(id);
      if (b) p.line(mol.pos(b.a), mol.pos(b.b), 0.3, color);
    }
    for (const id of h.atoms) if (mol.atoms.has(id)) p.circle(mol.pos(id), 0.3, color);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = alpha;
    ctx.drawImage(layer, 0, 0);
    ctx.restore();
  }

  /** Trace a closed outline given in screen px. */
  private outline(points: readonly Vec[]): void {
    const { ctx, dpr } = this;
    ctx.beginPath();
    points.forEach((pt, i) => (i ? ctx.lineTo(pt.x * dpr, pt.y * dpr) : ctx.moveTo(pt.x * dpr, pt.y * dpr)));
    ctx.closePath();
  }

  /** Dashed frame round the selection, with a handle on a stalk for turning it. */
  private drawFrame(corners: Vec[], handle: boolean, theme: Theme): void {
    const { ctx, dpr } = this;
    ctx.save();
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 1.25 * dpr;
    ctx.setLineDash([5 * dpr, 4 * dpr]);
    this.outline(corners);
    ctx.stroke();
    if (handle) {
      const { base, knob } = frameHandle(corners);
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(base.x * dpr, base.y * dpr);
      ctx.lineTo(knob.x * dpr, knob.y * dpr);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(knob.x * dpr, knob.y * dpr, 6.5 * dpr, 0, TAU);
      ctx.fillStyle = theme.surface;
      ctx.fill();
      ctx.lineWidth = 1.75 * dpr;
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawMarquee(points: Vec[], lasso: boolean, theme: Theme): void {
    if (points.length < 2) return;
    const { ctx, dpr } = this;
    ctx.save();
    this.outline(points);
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = theme.accent;
    ctx.fill();
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 1.5 * dpr;
    ctx.lineJoin = 'round';
    ctx.setLineDash(lasso ? [] : [6 * dpr, 4 * dpr]);
    if (lasso) {
      // The drawn path solid; the closing edge it will join up with dashed.
      ctx.beginPath();
      points.forEach((pt, i) => (i ? ctx.lineTo(pt.x * dpr, pt.y * dpr) : ctx.moveTo(pt.x * dpr, pt.y * dpr)));
      ctx.stroke();
      const a = points[points.length - 1];
      const b = points[0];
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(a.x * dpr, a.y * dpr);
      ctx.lineTo(b.x * dpr, b.y * dpr);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawPulse(at: Vec, t: number, theme: Theme): void {
    const { ctx, dpr } = this;
    ctx.save();
    ctx.globalAlpha = 0.7 * (1 - t);
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 2.5 * (1 - t * 0.6) * dpr;
    ctx.beginPath();
    ctx.arc(at.x * dpr, at.y * dpr, (12 + 20 * t) * dpr, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  /** The hex "graph paper": honeycomb vertices that zig-zags and rings snap onto. */
  private drawLattice(view: View, theme: Theme): void {
    const fade = clamp((view.scale - 16) / 16, 0, 1);
    if (fade <= 0) return;
    const { ctx, dpr } = this;
    const r = Math.max(1, view.scale * 0.03) * dpr;
    ctx.globalAlpha = fade;
    ctx.fillStyle = theme.lattice;
    ctx.beginPath();
    forEachLatticePoint(view.visibleBox(this.width, this.height), (pt) => {
      const x = (pt.x * view.scale + view.x) * dpr;
      const y = (pt.y * view.scale + view.y) * dpr;
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, TAU);
    });
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  private drawInk(points: InkPoint[], color: string, alpha: number): void {
    if (points.length === 0 || alpha <= 0) return;
    const { ctx, dpr } = this;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const base = 3.5 * dpr;
    const pressured = points.some((pt) => pt.pressure > 0 && Math.abs(pt.pressure - 0.5) > 0.01);
    if (pressured) {
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        ctx.lineWidth = base * (0.35 + 1.3 * b.pressure);
        ctx.beginPath();
        ctx.moveTo(a.x * dpr, a.y * dpr);
        ctx.lineTo(b.x * dpr, b.y * dpr);
        ctx.stroke();
      }
    } else {
      ctx.lineWidth = base;
      ctx.beginPath();
      ctx.moveTo(points[0].x * dpr, points[0].y * dpr);
      for (let i = 1; i < points.length - 1; i++) {
        const a = points[i];
        const b = points[i + 1];
        ctx.quadraticCurveTo(a.x * dpr, a.y * dpr, ((a.x + b.x) / 2) * dpr, ((a.y + b.y) / 2) * dpr);
      }
      const last = points[points.length - 1];
      ctx.lineTo(last.x * dpr, last.y * dpr);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** A small tag near the finger naming what the stroke will make. */
  private drawPill(text: string, at: Vec, color: string, theme: Theme): void {
    const { ctx, dpr } = this;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.font = `600 ${12 * dpr}px ${theme.uiFont}`;
    const w = ctx.measureText(text).width + 18 * dpr;
    const h = 22 * dpr;
    let x = (at.x + 16) * dpr;
    let y = (at.y - 40) * dpr;
    x = clamp(x, 8 * dpr, this.canvas.width - w - 8 * dpr);
    y = clamp(y, 8 * dpr, this.canvas.height - h - 8 * dpr);
    ctx.fillStyle = color;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, h / 2);
    else ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.fillStyle = theme.paper;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 9 * dpr, y + h / 2 + 0.5 * dpr);
    ctx.restore();
  }
}
