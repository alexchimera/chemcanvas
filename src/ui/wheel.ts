import { clamp, type Vec } from '../core/geometry';

export interface WheelItem {
  key: string;
  title: string;
  label?: string;
  /** Trusted inline SVG from icons.ts. */
  icon?: string;
  className?: string;
}

export interface WheelOptions {
  center: string;
  centerClass?: string;
  items: WheelItem[];
  onPick: (key: string) => void;
  /** Accept a typed element symbol; return false to reject it. */
  onType?: (text: string) => boolean;
}

/**
 * A radial menu that opens around the tapped atom or bond. Tap an item, or
 * (on the atom wheel) type a symbol such as "Si" and press Enter.
 */
export class Wheel {
  private readonly el: HTMLDivElement;
  private opts: WheelOptions | null = null;
  private typed = '';
  private hub: HTMLButtonElement | null = null;
  private input: HTMLInputElement | null = null;
  private openedAt = 0;

  /** Called whenever the wheel closes, however it was closed. */
  onClose: (() => void) | null = null;

  constructor(host: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'wheel';
    this.el.hidden = true;
    this.el.setAttribute('role', 'menu');
    host.append(this.el);
  }

  get isOpen(): boolean {
    return this.opts !== null;
  }

  open(at: Vec, opts: WheelOptions, bounds: { width: number; height: number }): void {
    this.close();
    this.opts = opts;
    this.typed = '';
    this.openedAt = performance.now();
    const n = opts.items.length;
    const radius = clamp((n * 52) / (2 * Math.PI), 66, 116);
    const reach = radius + 30;
    this.el.style.left = `${clamp(at.x, reach + 8, Math.max(reach + 8, bounds.width - reach - 8))}px`;
    this.el.style.top = `${clamp(at.y, reach + 8, Math.max(reach + 8, bounds.height - reach - 8))}px`;
    this.el.replaceChildren();

    const hub = document.createElement('button');
    hub.type = 'button';
    hub.className = `wheel-hub ${opts.centerClass ?? ''}`;
    hub.textContent = opts.center;
    hub.title = 'Close';
    hub.setAttribute('aria-label', 'Close menu');
    hub.addEventListener('click', () => {
      // A tap that opened the wheel can be followed by a stray click under the finger.
      if (performance.now() - this.openedAt > 350) this.close();
    });
    this.el.append(hub);
    this.hub = hub;

    opts.items.forEach((item, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `wheel-item ${item.className ?? ''}`;
      btn.setAttribute('role', 'menuitem');
      btn.setAttribute('aria-label', item.title);
      btn.title = item.title;
      btn.style.setProperty('--dx', `${Math.cos(angle) * radius}px`);
      btn.style.setProperty('--dy', `${Math.sin(angle) * radius}px`);
      btn.style.setProperty('--i', String(i));
      if (item.icon) btn.innerHTML = item.icon;
      else btn.textContent = item.label ?? item.key;
      btn.addEventListener('click', () => {
        if (item.key === 'more') this.promptSymbol();
        else this.pick(item.key);
      });
      this.el.append(btn);
    });

    this.el.hidden = false;
    requestAnimationFrame(() => this.el.classList.add('open'));
  }

  close(): void {
    if (!this.opts) return;
    this.opts = null;
    this.hub = null;
    this.input = null;
    this.el.classList.remove('open');
    this.el.hidden = true;
    this.el.replaceChildren();
    this.onClose?.();
  }

  /** Keyboard while open: Escape closes; letters and Enter type an element symbol. */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.opts) return false;
    if (e.key === 'Escape') {
      this.close();
      return true;
    }
    if (!this.opts.onType) return false;
    if (/^[a-zA-Z]$/.test(e.key) && this.typed.length < 3) {
      this.typed += e.key;
      this.showTyped();
      return true;
    }
    if (e.key === 'Backspace' && this.typed) {
      this.typed = this.typed.slice(0, -1);
      this.showTyped();
      return true;
    }
    if (e.key === 'Enter' && this.typed) {
      this.submit(this.typed);
      return true;
    }
    return false;
  }

  private showTyped(): void {
    if (!this.hub || !this.opts) return;
    this.hub.textContent = this.typed || this.opts.center;
    this.hub.classList.toggle('typing', this.typed.length > 0);
  }

  private submit(text: string): void {
    const opts = this.opts;
    if (!opts?.onType) return;
    if (opts.onType(text)) {
      this.close();
      return;
    }
    this.typed = '';
    this.showTyped();
    const field = this.input ?? this.hub;
    if (this.input) this.input.select();
    field?.classList.remove('nope');
    void field?.offsetWidth;
    field?.classList.add('nope');
  }

  /** Swap the hub for a text field (touch devices have no hardware keyboard). */
  private promptSymbol(): void {
    if (!this.hub) return;
    const input = document.createElement('input');
    input.className = 'wheel-input';
    input.id = 'wheel-symbol';
    input.maxLength = 3;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('aria-label', 'Element symbol');
    input.placeholder = 'Si';
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && input.value.trim()) this.submit(input.value.trim());
      if (e.key === 'Escape') this.close();
    });
    this.hub.replaceWith(input);
    this.hub = null;
    this.input = input;
    input.focus();
  }

  private pick(key: string): void {
    const opts = this.opts;
    this.close();
    opts?.onPick(key);
  }
}
