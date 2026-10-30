import type { Box, Vec } from '../core/geometry';

export interface TextStyle {
  size: number;
  weight: number;
  family: string;
}

/**
 * Drawing primitives in model coordinates, so a single depiction routine can
 * target the live canvas and SVG export alike. Text is left-aligned on its
 * alphabetic baseline.
 */
export interface Painter {
  alpha: number;
  line(a: Vec, b: Vec, width: number, color: string): void;
  polyline(points: readonly Vec[], width: number, color: string): void;
  polygon(points: readonly Vec[], color: string): void;
  circle(center: Vec, radius: number, fill: string | null, stroke?: string | null, width?: number): void;
  text(text: string, at: Vec, style: TextStyle, color: string): void;
}

/** Paints onto a 2D canvas; device px = model × k + offset. */
export class CanvasPainter implements Painter {
  alpha = 1;

  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    private readonly k: number,
    private readonly ox: number,
    private readonly oy: number,
  ) {}

  private begin(color: string, width?: number): CanvasRenderingContext2D {
    const c = this.ctx;
    c.globalAlpha = this.alpha;
    c.strokeStyle = color;
    c.fillStyle = color;
    if (width !== undefined) c.lineWidth = width * this.k;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.beginPath();
    return c;
  }

  private trace(c: CanvasRenderingContext2D, points: readonly Vec[]): void {
    points.forEach((p, i) => {
      const x = p.x * this.k + this.ox;
      const y = p.y * this.k + this.oy;
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    });
  }

  line(a: Vec, b: Vec, width: number, color: string): void {
    const c = this.begin(color, width);
    this.trace(c, [a, b]);
    c.stroke();
  }

  polyline(points: readonly Vec[], width: number, color: string): void {
    const c = this.begin(color, width);
    this.trace(c, points);
    c.stroke();
  }

  polygon(points: readonly Vec[], color: string): void {
    const c = this.begin(color);
    this.trace(c, points);
    c.closePath();
    c.fill();
  }

  circle(center: Vec, radius: number, fill: string | null, stroke?: string | null, width = 0.04): void {
    const c = this.begin(stroke ?? fill ?? '#000', width);
    c.arc(center.x * this.k + this.ox, center.y * this.k + this.oy, radius * this.k, 0, Math.PI * 2);
    if (fill) {
      c.fillStyle = fill;
      c.fill();
    }
    if (stroke) c.stroke();
  }

  text(text: string, at: Vec, style: TextStyle, color: string): void {
    const c = this.ctx;
    c.globalAlpha = this.alpha;
    c.fillStyle = color;
    c.font = `${style.weight} ${style.size * this.k}px ${style.family}`;
    c.textAlign = 'left';
    c.textBaseline = 'alphabetic';
    c.fillText(text, at.x * this.k + this.ox, at.y * this.k + this.oy);
  }
}

const num = (v: number) => String(Math.round(v * 1000) / 1000);
const pointList = (pts: readonly Vec[]) => pts.map((p) => `${num(p.x)},${num(p.y)}`).join(' ');
const escapeXml = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

/** Collects SVG elements in model units; `toString` wraps them in a sized <svg>. */
export class SvgPainter implements Painter {
  alpha = 1;
  private readonly parts: string[] = [];

  private opacity(): string {
    return this.alpha < 1 ? ` opacity="${num(this.alpha)}"` : '';
  }

  line(a: Vec, b: Vec, width: number, color: string): void {
    this.parts.push(
      `<line x1="${num(a.x)}" y1="${num(a.y)}" x2="${num(b.x)}" y2="${num(b.y)}" stroke="${color}" stroke-width="${num(width)}" stroke-linecap="round"${this.opacity()}/>`,
    );
  }

  polyline(points: readonly Vec[], width: number, color: string): void {
    this.parts.push(
      `<polyline points="${pointList(points)}" fill="none" stroke="${color}" stroke-width="${num(width)}" stroke-linecap="round" stroke-linejoin="round"${this.opacity()}/>`,
    );
  }

  polygon(points: readonly Vec[], color: string): void {
    this.parts.push(`<polygon points="${pointList(points)}" fill="${color}"${this.opacity()}/>`);
  }

  circle(center: Vec, radius: number, fill: string | null, stroke?: string | null, width = 0.04): void {
    const strokeAttrs = stroke ? ` stroke="${stroke}" stroke-width="${num(width)}"` : '';
    this.parts.push(
      `<circle cx="${num(center.x)}" cy="${num(center.y)}" r="${num(radius)}" fill="${fill ?? 'none'}"${strokeAttrs}${this.opacity()}/>`,
    );
  }

  text(text: string, at: Vec, style: TextStyle, color: string): void {
    this.parts.push(
      `<text x="${num(at.x)}" y="${num(at.y)}" font-family="${style.family}" font-size="${num(style.size)}" font-weight="${style.weight}" fill="${color}"${this.opacity()}>${escapeXml(text)}</text>`,
    );
  }

  toString(box: Box, pxPerUnit: number): string {
    const w = box.maxX - box.minX;
    const h = box.maxY - box.minY;
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${num(box.minX)} ${num(box.minY)} ${num(w)} ${num(h)}" ` +
      `width="${Math.round(w * pxPerUnit)}" height="${Math.round(h * pxPerUnit)}">${this.parts.join('')}</svg>`
    );
  }
}
