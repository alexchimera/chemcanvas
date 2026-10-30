import {
  angleDiff,
  angleOf,
  boundsOf,
  closestOnSegment,
  deg,
  dist,
  distToPolyline,
  pathLength,
  resample,
  resampleClosed,
  segmentIntersection,
  signedArea,
  simplify,
  sub,
  totalTurning,
  TAU,
  type Vec,
} from '../core/geometry';

/** A resampled stroke with cumulative arc length, for "closest point ahead" queries. */
export class StrokeTrack {
  readonly pts: Vec[];
  readonly cum: number[];
  readonly total: number;

  constructor(points: readonly Vec[], spacing = 0.05) {
    this.pts = resample(points, spacing);
    this.cum = [0];
    for (let i = 1; i < this.pts.length; i++) this.cum.push(this.cum[i - 1] + dist(this.pts[i - 1], this.pts[i]));
    this.total = this.cum[this.cum.length - 1];
  }

  get end(): Vec {
    return this.pts[this.pts.length - 1];
  }

  /** Closest point to `q` on the stretch of stroke between arc lengths s0 and s1. */
  closest(q: Vec, s0 = 0, s1 = Infinity): { dist: number; s: number } {
    const n = this.pts.length;
    if (n === 1) return { dist: dist(q, this.pts[0]), s: 0 };
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cum[mid] <= s0) lo = mid;
      else hi = mid - 1;
    }
    let best = Infinity;
    let bestS = this.total;
    for (let i = Math.min(lo, n - 2); i < n - 1 && this.cum[i] <= s1; i++) {
      const c = closestOnSegment(q, this.pts[i], this.pts[i + 1]);
      if (c.dist < best) {
        best = c.dist;
        bestS = this.cum[i] + c.t * (this.cum[i + 1] - this.cum[i]);
      }
    }
    if (best === Infinity) return { dist: dist(q, this.end), s: this.total };
    return { dist: best, s: bestS };
  }

  distanceTo(q: Vec): number {
    return distToPolyline(q, this.pts);
  }

  /** The first `length` units of the stroke. */
  prefix(length: number): StrokeTrack {
    if (length >= this.total) return this;
    let k = 1;
    while (k < this.pts.length - 1 && this.cum[k] < length) k++;
    return new StrokeTrack(this.pts.slice(0, k + 1));
  }
}

/**
 * If the stroke closes on itself (end near start, or crossing its own
 * beginning), return the loop without any lead-in tail or overshoot.
 */
export function closedLoop(points: readonly Vec[]): Vec[] | null {
  const total = pathLength(points);
  if (total < 1.8) return null;
  // Any loop turns through most of a revolution; zig-zags and arcs don't.
  if (Math.abs(totalTurning(resample(points, Math.max(total / 60, 0.05)))) < deg(200)) return null;
  const pts = resample(points, Math.max(total / 160, 0.02));
  const n = pts.length;
  if (n < 8) return null;
  const box = boundsOf(pts)!;
  const diag = Math.hypot(box.maxX - box.minX, box.maxY - box.minY);

  // Candidate loops, most specific first: the stroke crossing its own beginning
  // (overshoot, or a lead-in tail), nearly touching it, or ending near the start.
  const crossings: { span: number; loop: Vec[] }[] = [];
  const touches: { span: number; loop: Vec[] }[] = [];
  const near = Math.max(0.25, 0.08 * diag);
  const earlyEnd = Math.floor(n * 0.45);
  const lateStart = Math.floor(n * 0.55);
  for (let i = 0; i < earlyEnd; i++) {
    for (let j = Math.max(lateStart, i + 3); j < n - 1; j++) {
      const hit = segmentIntersection(pts[i], pts[i + 1], pts[j], pts[j + 1]);
      if (hit) crossings.push({ span: j - i, loop: [hit.point, ...pts.slice(i + 1, j + 1)] });
      else if (dist(pts[i], pts[j]) < near) touches.push({ span: j - i, loop: pts.slice(i, j + 1) });
    }
  }
  // Widest first; a candidate that keeps a stub of the lead-in tail fails the
  // roundness test and the next, tighter one is tried.
  const candidates = [
    ...crossings.sort((a, b) => b.span - a.span).slice(0, 20),
    ...touches.sort((a, b) => b.span - a.span).slice(0, 40),
  ].map((c) => c.loop);
  if (dist(pts[0], pts[n - 1]) <= Math.max(0.3 * diag, 0.25)) candidates.push(pts);
  return candidates.find(isRoundLoop) ?? null;
}

function isRoundLoop(loop: Vec[]): boolean {
  if (loop.length < 6) return false;
  const perimeter = pathLength(loop, true);
  const roundness = (4 * Math.PI * Math.abs(signedArea(loop))) / (perimeter * perimeter);
  if (perimeter < 1.8 || roundness < 0.3) return false;
  // A simple closed curve turns through exactly one revolution.
  const ring = resampleClosed(loop, 64);
  const turning = Math.abs(totalTurning([ring[63], ...ring, ring[0]]));
  return turning >= deg(300) && turning <= deg(420);
}

/**
 * A scratch-out: several sharp back-and-forth reversals, or tight circling.
 * Zig-zag chains turn by ~60° per corner, so they are never mistaken for one.
 */
export function isScribble(points: readonly Vec[]): boolean {
  const total = pathLength(points);
  if (total < 1.2) return false;
  const pts = simplify(resample(points, 0.04), 0.1);
  let corners = 0;
  let reversals = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const turn = Math.abs(angleDiff(angleOf(sub(pts[i + 1], pts[i])), angleOf(sub(pts[i], pts[i - 1]))));
    if (turn > deg(35)) corners++;
    if (turn > deg(130)) reversals++;
  }
  if (reversals >= 3 && reversals >= corners * 0.5) return true;
  return Math.abs(totalTurning(resample(points, 0.08))) > 2.2 * TAU;
}

/**
 * Count the corners of a hand-drawn loop: a smooth circle reads as the default
 * six-membered ring, a polygon with 3–8 clear corners as that ring size.
 */
export function estimateRingSize(loop: readonly Vec[]): { size: number; corners: Vec[] | null } {
  const M = 96;
  const k = 4;
  const pts = resampleClosed(loop, M);
  const orient = Math.sign(signedArea(pts)) || 1;
  const raw = pts.map((p, i) => {
    const a = pts[(i - k + M) % M];
    const c = pts[(i + k) % M];
    return orient * angleDiff(angleOf(sub(c, p)), angleOf(sub(p, a)));
  });
  const turn = raw.map((t, i) => (raw[(i - 1 + M) % M] + 2 * t + raw[(i + 1) % M]) / 4);
  const median = [...turn].sort((a, b) => a - b)[M >> 1];
  const threshold = Math.max(deg(28), 1.6 * median);

  let peaks: number[] = [];
  for (let i = 0; i < M; i++) {
    if (turn[i] < threshold) continue;
    let isMax = true;
    for (let j = 1; j <= k && isMax; j++) {
      if (turn[(i + j) % M] > turn[i] || turn[(i - j + M) % M] >= turn[i]) isMax = false;
    }
    if (isMax) peaks.push(i);
  }
  // Merge peaks that sit on the same rounded corner.
  const merged: number[] = [];
  for (const p of peaks) {
    const last = merged[merged.length - 1];
    if (last !== undefined && p - last < M / 16) {
      if (turn[p] > turn[last]) merged[merged.length - 1] = p;
    } else merged.push(p);
  }
  if (merged.length > 1 && merged[0] + M - merged[merged.length - 1] < M / 16) {
    if (turn[merged[0]] >= turn[merged[merged.length - 1]]) merged.pop();
    else merged.shift();
  }
  peaks = merged;
  if (peaks.length < 3) return { size: 6, corners: null };

  const fits = (idx: number[]) => polygonFits(pts, idx.map((i) => pts[i]));
  // Drop kinks (e.g. where the pen started) that the polygon doesn't need.
  for (let changed = true; changed && peaks.length > 3; ) {
    changed = false;
    for (const cand of [...peaks].sort((a, b) => turn[a] - turn[b])) {
      const without = peaks.filter((p) => p !== cand);
      if (fits(without)) {
        peaks = without;
        changed = true;
        break;
      }
    }
  }
  if (peaks.length > 8 || !fits(peaks)) return { size: 6, corners: null };
  return { size: peaks.length, corners: peaks.map((i) => pts[i]) };
}

function polygonFits(pts: readonly Vec[], poly: readonly Vec[]): boolean {
  const side = pathLength(poly, true) / poly.length;
  let worst = 0;
  for (const p of pts) worst = Math.max(worst, distToPolyline(p, poly, true));
  return worst <= 0.18 * side;
}
