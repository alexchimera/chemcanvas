import { clamp, type Box } from '../core/geometry';

export interface BarItem {
  key: string;
  title: string;
  /** Trusted inline SVG from icons.ts. */
  icon: string;
  danger?: boolean;
}

/** A small floating toolbar that follows the selection around the canvas. */
export class SelectionBar {
  private readonly el: HTMLDivElement;

  constructor(host: HTMLElement, items: BarItem[], onPick: (key: string, from: HTMLElement, pointerType: string) => void) {
    this.el = document.createElement('div');
    this.el.className = 'selbar';
    this.el.setAttribute('role', 'toolbar');
    this.el.setAttribute('aria-label', 'Selection');
    this.el.hidden = true;
    for (const item of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `tool${item.danger ? ' danger' : ''}`;
      btn.dataset.key = item.key;
      btn.title = item.title;
      btn.setAttribute('aria-label', item.title);
      btn.innerHTML = item.icon;
      btn.addEventListener('click', (e) => onPick(item.key, btn, (e as PointerEvent).pointerType || 'mouse'));
      this.el.append(btn);
    }
    host.append(this.el);
  }

  /**
   * Sit just below the selection frame (px within the host), or above it,
   * clear of the rotate handle, when there's no room below. `area` is the
   * part of the host not covered by other panels.
   */
  show(frame: Box, handleGap: number, area: Box): void {
    const first = this.el.hidden;
    this.el.hidden = false;
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    let y = frame.maxY + 12;
    if (y + h > area.maxY) y = frame.minY - handleGap - 10 - h;
    const x = clamp((frame.minX + frame.maxX) / 2 - w / 2, area.minX, Math.max(area.minX, area.maxX - w));
    this.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(clamp(y, area.minY, Math.max(area.minY, area.maxY - h)))}px)`;
    if (first) {
      this.el.classList.remove('in');
      requestAnimationFrame(() => this.el.classList.add('in'));
    }
  }

  hide(): void {
    this.el.hidden = true;
  }
}
