import { chargeText, hasValenceError, implicitHydrogens } from '../core/chemistry';
import {
  add,
  angleDiff,
  angleOf,
  cross,
  deg,
  dist,
  lerp,
  normalize,
  perp,
  polar,
  scale,
  sub,
  type Box,
  type Vec,
} from '../core/geometry';
import type { Atom, Bond, Molecule } from '../core/molecule';
import { freeDirection, neighborAngles } from '../core/placement';
import { findRings, ringCenter, type Ring } from '../core/rings';
import { textWidth } from './measure';
import type { Painter, TextStyle } from './painter';

/**
 * Proportions from the ACS 1996 document style (14.4 pt bonds, 0.6 pt lines,
 * 18% double-bond spacing, 10 pt Arial labels), with lines a touch heavier
 * for screens.
 */
export const STYLE = {
  lineWidth: 0.048,
  doubleSpacing: 0.18,
  wedgeWidth: 0.17,
  hashSpacing: 0.13,
  fontSize: 0.62,
  margin: 0.1,
  fontFamily: 'Arial, Helvetica, sans-serif',
};

/** Arial cap height as a fraction of the em. */
const CAP = 0.716;

export interface DepictColors {
  ink: string;
  danger: string;
  element(symbol: string): string;
}

export interface DepictOptions {
  /** Override colours of particular atoms or bonds (live previews, erase targets). */
  atomColor?: (id: number) => string | undefined;
  bondColor?: (id: number) => string | undefined;
  showValenceErrors?: boolean;
  /** Paint label areas in this colour first, so a patterned background doesn't show through. */
  knockout?: string;
}

interface Label {
  runs: { text: string; at: Vec; style: TextStyle }[];
  /** Areas bonds must stay out of. */
  boxes: Box[];
  color: string;
}

export function depict(p: Painter, mol: Molecule, colors: DepictColors, opts: DepictOptions = {}): void {
  const labels = new Map<number, Label>();
  for (const atom of mol.atoms.values()) {
    const label = layoutLabel(mol, atom, opts.atomColor?.(atom.id) ?? colors.element(atom.element));
    if (label) labels.set(atom.id, label);
  }
  if (opts.knockout) {
    const pad = STYLE.margin * 0.4;
    for (const label of labels.values()) {
      for (const b of label.boxes) {
        const box = { minX: b.minX + pad, minY: b.minY + pad, maxX: b.maxX - pad, maxY: b.maxY - pad };
        p.polygon(
          [
            { x: box.minX, y: box.minY },
            { x: box.maxX, y: box.minY },
            { x: box.maxX, y: box.maxY },
            { x: box.minX, y: box.maxY },
          ],
          opts.knockout,
        );
      }
    }
  }
  if (opts.showValenceErrors) {
    p.alpha = 0.16;
    for (const atom of mol.atoms.values()) if (hasValenceError(mol, atom.id)) p.circle(atom, 0.38, colors.danger);
    p.alpha = 1;
  }
  const rings = findRings(mol);
  for (const bond of mol.bonds.values()) {
    drawBond(p, mol, bond, labels, rings, opts.bondColor?.(bond.id) ?? colors.ink);
  }
  for (const label of labels.values()) for (const run of label.runs) p.text(run.text, run.at, run.style, label.color);
  for (const atom of mol.atoms.values()) {
    if (labels.has(atom.id) || atom.charge === 0) continue;
    drawVertexCharge(p, mol, atom, opts.atomColor?.(atom.id) ?? colors.ink);
  }
}

function drawBond(p: Painter, mol: Molecule, bond: Bond, labels: Map<number, Label>, rings: Ring[], color: string): void {
  const a = mol.pos(bond.a);
  const b = mol.pos(bond.b);
  const boxesA = labels.get(bond.a)?.boxes;
  const boxesB = labels.get(bond.b)?.boxes;
  const w = STYLE.lineWidth;
  const seg = (s: Vec, e: Vec) => {
    const c = clip(s, e, boxesA, boxesB);
    if (c) p.line(c[0], c[1], w, color);
  };

  if (bond.stereo === 'wedge' || bond.stereo === 'hash' || bond.stereo === 'wavy') {
    const c = clip(a, b, boxesA, boxesB);
    if (c) drawStereo(p, bond.stereo, a, b, c[0], c[1], color);
    return;
  }
  if (bond.order === 1) {
    seg(a, b);
    return;
  }
  const u = normalize(sub(b, a));
  const n = perp(u);
  const d = STYLE.doubleSpacing;
  if (bond.order === 3) {
    seg(a, b);
    seg(add(a, scale(n, d)), add(b, scale(n, d)));
    seg(sub(a, scale(n, d)), sub(b, scale(n, d)));
    return;
  }
  const side = doubleBondSide(mol, bond, rings, labels);
  if (side === 0) {
    const h = scale(n, d / 2);
    seg(add(a, h), add(b, h));
    seg(sub(a, h), sub(b, h));
    return;
  }
  seg(a, b);
  const off = scale(n, d * side);
  const trimA = labels.has(bond.a) ? 0 : innerTrim(mol, bond.a, bond.b, a, b, side);
  const trimB = labels.has(bond.b) ? 0 : innerTrim(mol, bond.b, bond.a, a, b, side);
  seg(add(add(a, off), scale(u, trimA)), sub(add(b, off), scale(u, trimB)));
}

/**
 * Which side of a→b the second line of a double bond goes on: inside its
 * ring, toward the busier side of a chain, or centred (0) for C=O and other
 * terminal or symmetric cases.
 */
function doubleBondSide(mol: Molecule, bond: Bond, rings: Ring[], labels: Map<number, Label>): number {
  const a = mol.pos(bond.a);
  const b = mol.pos(bond.b);
  const around = rings.filter((r) => r.bonds.includes(bond.id));
  if (around.length) {
    const doubles = (r: Ring) => r.bonds.filter((id) => mol.bonds.get(id)!.order === 2).length;
    around.sort((x, y) => doubles(y) - doubles(x) || x.atoms.length - y.atoms.length);
    return Math.sign(cross(sub(b, a), sub(ringCenter(mol, around[0]), a))) || 1;
  }
  const degA = mol.degree(bond.a);
  const degB = mol.degree(bond.b);
  if ((degA === 1 && labels.has(bond.a)) || (degB === 1 && labels.has(bond.b))) return 0;
  let tally = 0;
  for (const [atom, partner] of [
    [bond.a, bond.b],
    [bond.b, bond.a],
  ]) {
    for (const q of mol.neighbors(atom)) {
      if (q !== partner) tally += Math.sign(cross(sub(b, a), sub(mol.pos(q), a)));
    }
  }
  return Math.sign(tally);
}

/** Shorten the inner line of a double bond so it ends on the bisector of the neighbouring bond. */
function innerTrim(mol: Molecule, at: number, partner: number, a: Vec, b: Vec, side: number): number {
  const d = STYLE.doubleSpacing;
  const p0 = mol.pos(at);
  const toPartner = angleOf(sub(mol.pos(partner), p0));
  let trim = d * 0.6;
  for (const q of mol.neighbors(at)) {
    if (q === partner) continue;
    const pq = mol.pos(q);
    if (Math.sign(cross(sub(b, a), sub(pq, a))) !== side) continue;
    const theta = Math.abs(angleDiff(angleOf(sub(pq, p0)), toPartner));
    if (theta > 0.2) trim = Math.max(trim, d / Math.tan(theta / 2));
  }
  return Math.min(trim, 0.4);
}

function drawStereo(p: Painter, stereo: 'wedge' | 'hash' | 'wavy', a: Vec, b: Vec, s: Vec, e: Vec, color: string): void {
  const full = dist(a, b);
  const u = normalize(sub(b, a));
  const n = perp(u);
  const widthAt = (pt: Vec) => STYLE.lineWidth + (STYLE.wedgeWidth - STYLE.lineWidth) * (dist(a, pt) / full);
  if (stereo === 'wedge') {
    const ws = widthAt(s) / 2;
    const we = widthAt(e) / 2;
    p.polygon([add(s, scale(n, ws)), add(e, scale(n, we)), sub(e, scale(n, we)), sub(s, scale(n, ws))], color);
    return;
  }
  const len = dist(s, e);
  if (stereo === 'hash') {
    const count = Math.max(3, Math.round(len / STYLE.hashSpacing));
    for (let i = 1; i <= count; i++) {
      const pt = lerp(s, e, i / count);
      const half = widthAt(pt) / 2;
      p.line(add(pt, scale(n, half)), sub(pt, scale(n, half)), STYLE.lineWidth * 0.85, color);
    }
    return;
  }
  const waves = Math.max(3, Math.round(len / 0.16));
  const pts: Vec[] = [];
  for (let i = 0; i <= waves * 8; i++) {
    const t = i / (waves * 8);
    pts.push(add(lerp(s, e, t), scale(n, Math.sin(t * waves * Math.PI) * 0.06)));
  }
  p.polyline(pts, STYLE.lineWidth, color);
}

/** Clip segment s→e so it stops at the label boxes around either end. */
function clip(s: Vec, e: Vec, boxesS?: Box[], boxesE?: Box[]): [Vec, Vec] | null {
  let t0 = 0;
  let t1 = 1;
  for (const box of boxesS ?? []) t0 = Math.max(t0, exitParam(s, e, box));
  for (const box of boxesE ?? []) t1 = Math.min(t1, 1 - exitParam(e, s, box));
  if (t1 - t0 < 0.02) return null;
  return [lerp(s, e, t0), lerp(s, e, t1)];
}

/** Parameter at which the segment from→to leaves `box`, or 0 if it starts outside it. */
function exitParam(from: Vec, to: Vec, box: Box): number {
  if (from.x < box.minX || from.x > box.maxX || from.y < box.minY || from.y > box.maxY) return 0;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let t = Infinity;
  if (dx > 0) t = Math.min(t, (box.maxX - from.x) / dx);
  else if (dx < 0) t = Math.min(t, (box.minX - from.x) / dx);
  if (dy > 0) t = Math.min(t, (box.maxY - from.y) / dy);
  else if (dy < 0) t = Math.min(t, (box.minY - from.y) / dy);
  return Math.min(1, t);
}

/**
 * Lay out a heteroatom label such as "OH", "H₂N" or "N⁺" centred on the
 * atom's symbol. Skeletal carbons get no label unless they stand alone.
 */
function layoutLabel(mol: Molecule, atom: Atom, color: string): Label | null {
  if (atom.element === 'C' && mol.degree(atom.id) > 0) return null;
  const main: TextStyle = { size: STYLE.fontSize, weight: 400, family: STYLE.fontFamily };
  const small: TextStyle = { ...main, size: STYLE.fontSize * 0.7 };
  const cap = CAP * main.size;
  const m = STYLE.margin;
  const wSym = textWidth(atom.element, main);
  const x0 = atom.x - wSym / 2;
  const base = atom.y + cap / 2;
  const runs: Label['runs'] = [{ text: atom.element, at: { x: x0, y: base }, style: main }];
  const boxes: Box[] = [{ minX: x0 - m, maxX: x0 + wSym + m, minY: atom.y - cap / 2 - m, maxY: atom.y + cap / 2 + m }];
  let chargeX = x0 + wSym;

  const h = implicitHydrogens(mol, atom.id);
  if (h > 0) {
    const wH = textWidth('H', main);
    const count = h > 1 ? String(h) : '';
    const wN = count ? textWidth(count, small) : 0;
    const drop = main.size * 0.22;
    const side = hydrogenSide(mol, atom.id);
    let hx = x0 + wSym;
    let hy = base;
    if (side === 'right') chargeX = hx + wH + wN;
    else if (side === 'left') hx = x0 - wH - wN;
    else {
      hx = atom.x - wH / 2;
      hy = base + (side === 'up' ? -1.05 : 1.05) * main.size;
    }
    runs.push({ text: 'H', at: { x: hx, y: hy }, style: main });
    if (count) runs.push({ text: count, at: { x: hx + wH, y: hy + drop }, style: small });
    boxes.push({ minX: hx - m, maxX: hx + wH + wN + m, minY: hy - cap - m, maxY: hy + m + (count ? drop : 0) });
  }
  if (atom.charge !== 0) {
    runs.push({ text: chargeText(atom.charge), at: { x: chargeX + 0.02, y: base - cap * 0.62 }, style: small });
  }
  return { runs, boxes, color };
}

/** Put hydrogens on the horizontal side away from the bonds, or above/below when boxed in. */
function hydrogenSide(mol: Molecule, id: number): 'right' | 'left' | 'up' | 'down' {
  const angles = neighborAngles(mol, id);
  if (angles.length === 0) return 'right';
  if (angles.length === 1) return Math.cos(angles[0]) > 0.1 ? 'left' : 'right';
  const options = [
    ['right', 0],
    ['left', Math.PI],
    ['down', Math.PI / 2],
    ['up', -Math.PI / 2],
  ] as const;
  let best: 'right' | 'left' | 'up' | 'down' = 'right';
  let bestScore = -Infinity;
  for (const [side, dir] of options) {
    const clearance = Math.min(...angles.map((a) => Math.abs(angleDiff(a, dir))));
    const score = clearance + (side === 'right' || side === 'left' ? deg(20) : 0);
    if (score > bestScore + 1e-9) {
      best = side;
      bestScore = score;
    }
  }
  return best;
}

function drawVertexCharge(p: Painter, mol: Molecule, atom: Atom, color: string): void {
  const style: TextStyle = { size: STYLE.fontSize * 0.75, weight: 400, family: STYLE.fontFamily };
  const text = chargeText(atom.charge);
  const c = add(atom, polar(freeDirection(mol, atom.id), 0.38));
  p.text(text, { x: c.x - textWidth(text, style) / 2, y: c.y + (CAP * style.size) / 2 }, style, color);
}
