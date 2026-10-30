/**
 * Small 2D vector toolkit. Model space is y-down (like the screen) with a
 * standard bond length of 1, so most tolerances read as fractions of a bond.
 */

export interface Vec {
  x: number;
  y: number;
}

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const TAU = Math.PI * 2;

export const vec = (x: number, y: number): Vec => ({ x, y });
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec, b: Vec): number => a.x * b.y - a.y * b.x;
export const length = (a: Vec): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
export const midpoint = (a: Vec, b: Vec): Vec => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const lerp = (a: Vec, b: Vec, t: number): Vec => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});
/** Rotate by +90°. Only used to get "the other side" of a direction. */
export const perp = (a: Vec): Vec => ({ x: -a.y, y: a.x });
export const angleOf = (a: Vec): number => Math.atan2(a.y, a.x);
export const polar = (theta: number, r = 1): Vec => ({ x: Math.cos(theta) * r, y: Math.sin(theta) * r });
export const deg = (degrees: number): number => (degrees * Math.PI) / 180;
export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

export function normalize(a: Vec): Vec {
  const l = Math.hypot(a.x, a.y);
  return l > 1e-12 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
}

/** Wrap an angle into (-π, π]. */
export function wrapAngle(a: number): number {
  let r = a % TAU;
  if (r <= -Math.PI) r += TAU;
  else if (r > Math.PI) r -= TAU;
  return r;
}

/** Signed smallest difference `a − b`, in (-π, π]. */
export const angleDiff = (a: number, b: number): number => wrapAngle(a - b);

export function closestOnSegment(p: Vec, a: Vec, b: Vec): { point: Vec; t: number; dist: number } {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const l2 = abx * abx + aby * aby;
  const t = l2 > 0 ? clamp(((p.x - a.x) * abx + (p.y - a.y) * aby) / l2, 0, 1) : 0;
  const point = { x: a.x + abx * t, y: a.y + aby * t };
  return { point, t, dist: Math.hypot(p.x - point.x, p.y - point.y) };
}

export const distToSegment = (p: Vec, a: Vec, b: Vec): number => closestOnSegment(p, a, b).dist;

/** Intersection of segments ab and cd, with the parameters along each. */
export function segmentIntersection(
  a: Vec,
  b: Vec,
  c: Vec,
  d: Vec,
): { point: Vec; t: number; u: number } | null {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const qx = c.x - a.x;
  const qy = c.y - a.y;
  const t = (qx * sy - qy * sx) / denom;
  const u = (qx * ry - qy * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { point: { x: a.x + rx * t, y: a.y + ry * t }, t, u };
}

export function pathLength(pts: readonly Vec[], closed = false): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
  if (closed && pts.length > 2) total += dist(pts[pts.length - 1], pts[0]);
  return total;
}

export function distToPolyline(p: Vec, pts: readonly Vec[], closed = false): number {
  if (pts.length === 0) return Infinity;
  if (pts.length === 1) return dist(p, pts[0]);
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) best = Math.min(best, distToSegment(p, pts[i - 1], pts[i]));
  if (closed) best = Math.min(best, distToSegment(p, pts[pts.length - 1], pts[0]));
  return best;
}

/** Shoelace area; positive when the polygon winds clockwise on a y-down screen. */
export function signedArea(pts: readonly Vec[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function meanPoint(pts: readonly Vec[]): Vec {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  const n = Math.max(1, pts.length);
  return { x: x / n, y: y / n };
}

/** Area centroid of a polygon, falling back to the vertex mean for degenerate shapes. */
export function centroid(pts: readonly Vec[]): Vec {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const c = p.x * q.y - q.x * p.y;
    a += c;
    cx += (p.x + q.x) * c;
    cy += (p.y + q.y) * c;
  }
  if (Math.abs(a) < 1e-9) return meanPoint(pts);
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

export function pointInPolygon(p: Vec, poly: readonly Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function boundsOf(pts: Iterable<Vec>): Box | null {
  let box: Box | null = null;
  for (const p of pts) {
    if (!box) box = { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y };
    else {
      box.minX = Math.min(box.minX, p.x);
      box.minY = Math.min(box.minY, p.y);
      box.maxX = Math.max(box.maxX, p.x);
      box.maxY = Math.max(box.maxY, p.y);
    }
  }
  return box;
}

/** Resample an open polyline at a fixed arc-length spacing, keeping both ends. */
export function resample(pts: readonly Vec[], spacing: number): Vec[] {
  if (pts.length === 0) return [];
  const out: Vec[] = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    let a = pts[i - 1];
    const b = pts[i];
    let seg = dist(a, b);
    while (carry + seg >= spacing && seg > 0) {
      const p = lerp(a, b, (spacing - carry) / seg);
      out.push(p);
      a = p;
      seg = dist(a, b);
      carry = 0;
    }
    carry += seg;
  }
  const last = pts[pts.length - 1];
  const tail = out[out.length - 1];
  if (out.length > 1 && dist(tail, last) < spacing * 0.25) out[out.length - 1] = last;
  else if (dist(tail, last) > 1e-9) out.push(last);
  return out;
}

/** Resample a closed loop to exactly `n` evenly spaced points, starting at pts[0]. */
export function resampleClosed(pts: readonly Vec[], n: number): Vec[] {
  const ring = [...pts, pts[0]];
  const perimeter = pathLength(ring);
  if (perimeter === 0) return Array.from({ length: n }, () => pts[0]);
  const step = perimeter / n;
  const out: Vec[] = [];
  let acc = 0;
  let i = 1;
  for (let k = 0; k < n; k++) {
    const target = k * step;
    while (i < ring.length - 1 && acc + dist(ring[i - 1], ring[i]) < target) {
      acc += dist(ring[i - 1], ring[i]);
      i++;
    }
    const seg = dist(ring[i - 1], ring[i]);
    out.push(lerp(ring[i - 1], ring[i], seg > 0 ? clamp((target - acc) / seg, 0, 1) : 0));
  }
  return out;
}

/** Ramer–Douglas–Peucker simplification (segment distance, so reversals survive). */
export function simplify(pts: readonly Vec[], epsilon: number): Vec[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = distToSegment(pts[i], pts[s], pts[e]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > epsilon) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Sum of signed turning angles along an open polyline. */
export function totalTurning(pts: readonly Vec[]): number {
  let sum = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = angleOf(sub(pts[i], pts[i - 1]));
    const b = angleOf(sub(pts[i + 1], pts[i]));
    sum += angleDiff(b, a);
  }
  return sum;
}
