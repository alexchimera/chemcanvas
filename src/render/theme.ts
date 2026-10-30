import type { DepictColors } from './depict';

export interface Theme extends DepictColors {
  paper: string;
  lattice: string;
  accent: string;
  trail: string;
  surface: string;
  uiFont: string;
}

const ELEMENT_TOKEN: Record<string, string> = {
  N: '--el-n',
  O: '--el-o',
  S: '--el-s',
  P: '--el-p',
  F: '--el-hal',
  Cl: '--el-hal',
  Br: '--el-br',
  I: '--el-i',
  B: '--el-b',
};

const NONMETALS = new Set(['H', 'C', 'Se', 'Si', 'As', 'Te', 'Ge', 'He', 'Ne', 'Ar', 'Kr', 'Xe', 'Rn', ...Object.keys(ELEMENT_TOKEN)]);

/** Canvas colours come from the same CSS tokens as the rest of the page. */
export function readTheme(root: HTMLElement): Theme {
  const cs = getComputedStyle(root);
  const token = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const ink = token('--ink', '#15191e');
  const metal = token('--el-metal', ink);
  const colors: Record<string, string> = {};
  for (const [symbol, name] of Object.entries(ELEMENT_TOKEN)) colors[symbol] = token(name, ink);
  return {
    paper: token('--paper', '#ffffff'),
    lattice: token('--lattice', '#c8d4de'),
    ink,
    accent: token('--accent', '#2a5bd7'),
    danger: token('--danger', '#d83a3f'),
    trail: token('--trail', 'rgba(42, 91, 215, 0.35)'),
    surface: token('--surface', '#ffffff'),
    uiFont: token('--font-ui', 'system-ui, sans-serif'),
    element: (symbol) => colors[symbol] ?? (NONMETALS.has(symbol) ? ink : metal),
  };
}

const EXPORT_ELEMENT: Record<string, string> = {
  N: '#2f55d4',
  O: '#d23a2f',
  S: '#a88400',
  P: '#cc6a00',
  F: '#23883a',
  Cl: '#23883a',
  Br: '#9c3b2c',
  I: '#7440ad',
  B: '#b5654a',
};

/** Fixed print palette for exported images, whatever the screen theme. */
export const EXPORT_COLORS: DepictColors = {
  ink: '#000000',
  danger: '#d0021b',
  element: (symbol) => EXPORT_ELEMENT[symbol] ?? (NONMETALS.has(symbol) ? '#000000' : '#5a6470'),
};
