import { clamp, type Vec } from '../core/geometry';

export interface MenuChip {
  title: string;
  label?: string;
  /** Trusted inline SVG from icons.ts. */
  icon?: string;
  className?: string;
  active?: boolean;
  run: () => void;
}

export type MenuEntry =
  | { kind: 'action'; label: string; icon?: string; shortcut?: string; danger?: boolean; disabled?: boolean; run: () => void }
  | { kind: 'chips'; label?: string; chips: MenuChip[] }
  | { kind: 'divider' };

export interface MenuSpec {
  title: string;
  subtitle?: string;
  entries: MenuEntry[];
}

/**
 * The right-click menu. On a desktop it pops up at the pointer; on a phone it
 * slides up from the bottom as a sheet with finger-sized rows. Pointer presses
 * on `ignore` (the canvas) are left to the app, which closes the menu itself.
 */
export class ContextMenu {
  private readonly panel: HTMLDivElement;
  private readonly scrim: HTMLDivElement;
  private shown = false;

  /** Called whenever the menu closes, however it was closed. */
  onClose: (() => void) | null = null;

  constructor(host: HTMLElement, ignore: HTMLElement) {
    this.scrim = document.createElement('div');
    this.scrim.className = 'ctx-scrim';
    this.scrim.hidden = true;
    this.panel = document.createElement('div');
    this.panel.className = 'ctx';
    this.panel.setAttribute('role', 'menu');
    this.panel.tabIndex = -1;
    this.panel.hidden = true;
    host.append(this.scrim, this.panel);
    this.scrim.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.close();
    });
    document.addEventListener(
      'pointerdown',
      (e) => {
        const target = e.target as Node;
        if (this.shown && !this.panel.contains(target) && target !== ignore && target !== this.scrim) this.close();
      },
      true,
    );
  }

  get isOpen(): boolean {
    return this.shown;
  }

  /** Open at `at` (px within the host), or as a bottom sheet. */
  open(spec: MenuSpec, at: Vec, sheet: boolean, bounds: { width: number; height: number }): void {
    this.close();
    const head = document.createElement('div');
    head.className = 'ctx-head';
    const title = document.createElement('b');
    title.textContent = spec.title;
    head.append(title);
    if (spec.subtitle) {
      const sub = document.createElement('span');
      sub.textContent = spec.subtitle;
      head.append(sub);
    }
    this.panel.replaceChildren(head, ...spec.entries.map((entry) => this.render(entry)));
    this.panel.setAttribute('aria-label', spec.title);
    this.panel.classList.toggle('sheet', sheet);
    this.panel.classList.remove('open');
    this.panel.style.left = '';
    this.panel.style.top = '';
    this.panel.hidden = false;
    this.scrim.hidden = !sheet;
    if (!sheet) {
      const w = this.panel.offsetWidth;
      const h = this.panel.offsetHeight;
      const below = at.y + 4 + h <= bounds.height - 8;
      this.panel.style.left = `${clamp(at.x + 4, 8, Math.max(8, bounds.width - w - 8))}px`;
      this.panel.style.top = `${clamp(below ? at.y + 4 : at.y - h - 4, 8, Math.max(8, bounds.height - h - 8))}px`;
    }
    this.shown = true;
    requestAnimationFrame(() => this.shown && this.panel.classList.add('open'));
    this.panel.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.shown) return;
    this.shown = false;
    this.panel.hidden = true;
    this.scrim.hidden = true;
    this.panel.classList.remove('open');
    this.panel.replaceChildren();
    this.onClose?.();
  }

  /** Keys while open: Escape closes, arrows move between items. */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.shown) return false;
    if (e.key === 'Escape') {
      this.close();
      return true;
    }
    const items = [...this.panel.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (!items.length) return false;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = at < 0 ? 0 : (at + 1) % items.length;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    if (next < 0) return false;
    items[next].focus();
    return true;
  }

  private render(entry: MenuEntry): HTMLElement {
    if (entry.kind === 'divider') {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      sep.setAttribute('role', 'separator');
      return sep;
    }
    if (entry.kind === 'chips') {
      const row = document.createElement('div');
      row.className = 'ctx-chips';
      row.setAttribute('role', 'group');
      if (entry.label) {
        const label = document.createElement('span');
        label.className = 'ctx-chips-label';
        label.textContent = entry.label;
        row.append(label);
        row.setAttribute('aria-label', entry.label);
      }
      for (const chip of entry.chips) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `ctx-chip ${chip.className ?? ''}`;
        btn.setAttribute('role', 'menuitem');
        btn.setAttribute('aria-label', chip.title);
        btn.title = chip.title;
        if (chip.active) btn.setAttribute('aria-current', 'true');
        if (chip.icon) btn.innerHTML = chip.icon;
        else btn.textContent = chip.label ?? '';
        btn.addEventListener('click', () => this.pick(chip.run));
        row.append(btn);
      }
      return row;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `ctx-item${entry.danger ? ' danger' : ''}`;
    btn.setAttribute('role', 'menuitem');
    btn.disabled = entry.disabled ?? false;
    const icon = document.createElement('span');
    icon.className = 'ctx-icon';
    if (entry.icon) icon.innerHTML = entry.icon;
    const label = document.createElement('span');
    label.className = 'ctx-label';
    label.textContent = entry.label;
    btn.append(icon, label);
    if (entry.shortcut) {
      const key = document.createElement('kbd');
      key.textContent = entry.shortcut;
      btn.append(key);
    }
    btn.addEventListener('click', () => this.pick(entry.run));
    return btn;
  }

  private pick(run: () => void): void {
    this.close();
    run();
  }
}
