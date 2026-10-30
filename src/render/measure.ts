import type { TextStyle } from './painter';

let ctx: CanvasRenderingContext2D | null | undefined;
const cache = new Map<string, number>();

/** Width of `text` in model units, from canvas font metrics when a DOM is present. */
export function textWidth(text: string, style: TextStyle): number {
  const key = `${style.weight} ${style.family}|${text}`;
  let perEm = cache.get(key);
  if (perEm === undefined) {
    if (ctx === undefined) ctx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
    if (ctx) {
      ctx.font = `${style.weight} 100px ${style.family}`;
      perEm = ctx.measureText(text).width / 100;
    } else {
      perEm = text.length * 0.6;
    }
    cache.set(key, perEm);
  }
  return perEm * style.size;
}
