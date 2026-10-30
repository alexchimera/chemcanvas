import { clamp, type Box, type Vec } from '../core/geometry';

/** Pan/zoom transform: screen = model × scale + (x, y), in CSS pixels. */
export class View {
  static readonly MIN = 12;
  static readonly MAX = 180;
  scale = 44;
  x = 0;
  y = 0;

  toScreen(p: Vec): Vec {
    return { x: p.x * this.scale + this.x, y: p.y * this.scale + this.y };
  }

  toModel(p: Vec): Vec {
    return { x: (p.x - this.x) / this.scale, y: (p.y - this.y) / this.scale };
  }

  panBy(dx: number, dy: number): void {
    this.x += dx;
    this.y += dy;
  }

  /** Zoom by `factor`, keeping the model point under `p` fixed. */
  zoomAt(p: Vec, factor: number): void {
    const m = this.toModel(p);
    this.scale = clamp(this.scale * factor, View.MIN, View.MAX);
    this.x = p.x - m.x * this.scale;
    this.y = p.y - m.y * this.scale;
  }

  /** Centre a model box inside a screen rectangle, never zooming past `maxScale`. */
  fit(box: Box, rect: { x: number; y: number; width: number; height: number }, maxScale: number): void {
    const w = Math.max(box.maxX - box.minX, 1);
    const h = Math.max(box.maxY - box.minY, 1);
    this.scale = clamp(Math.min(rect.width / w, rect.height / h, maxScale), View.MIN, View.MAX);
    this.x = rect.x + rect.width / 2 - ((box.minX + box.maxX) / 2) * this.scale;
    this.y = rect.y + rect.height / 2 - ((box.minY + box.maxY) / 2) * this.scale;
  }

  visibleBox(width: number, height: number): Box {
    const a = this.toModel({ x: 0, y: 0 });
    const b = this.toModel({ x: width, y: height });
    return { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y };
  }
}
