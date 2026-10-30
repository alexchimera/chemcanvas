/** Element symbols in atomic-number order. */
export const ELEMENT_SYMBOLS = [
  'H', 'He', 'Li', 'Be', 'B', 'C', 'N', 'O', 'F', 'Ne', 'Na', 'Mg', 'Al', 'Si', 'P', 'S', 'Cl', 'Ar', 'K', 'Ca',
  'Sc', 'Ti', 'V', 'Cr', 'Mn', 'Fe', 'Co', 'Ni', 'Cu', 'Zn', 'Ga', 'Ge', 'As', 'Se', 'Br', 'Kr', 'Rb', 'Sr', 'Y', 'Zr',
  'Nb', 'Mo', 'Tc', 'Ru', 'Rh', 'Pd', 'Ag', 'Cd', 'In', 'Sn', 'Sb', 'Te', 'I', 'Xe', 'Cs', 'Ba', 'La', 'Ce', 'Pr', 'Nd',
  'Pm', 'Sm', 'Eu', 'Gd', 'Tb', 'Dy', 'Ho', 'Er', 'Tm', 'Yb', 'Lu', 'Hf', 'Ta', 'W', 'Re', 'Os', 'Ir', 'Pt', 'Au', 'Hg',
  'Tl', 'Pb', 'Bi', 'Po', 'At', 'Rn', 'Fr', 'Ra', 'Ac', 'Th', 'Pa', 'U', 'Np', 'Pu', 'Am', 'Cm', 'Bk', 'Cf', 'Es', 'Fm',
  'Md', 'No', 'Lr', 'Rf', 'Db', 'Sg', 'Bh', 'Hs', 'Mt', 'Ds', 'Rg', 'Cn', 'Nh', 'Fl', 'Mc', 'Lv', 'Ts', 'Og',
];

/**
 * Conventional standard atomic weights (IUPAC/CIAAW abridged values), indexed
 * like ELEMENT_SYMBOLS. Elements without stable isotopes use the mass number
 * of their longest-lived isotope.
 */
const STANDARD_MASSES = [
  1.008, 4.0026, 6.94, 9.0122, 10.81, 12.011, 14.007, 15.999, 18.998, 20.18, // H–Ne
  22.99, 24.305, 26.982, 28.085, 30.974, 32.06, 35.45, 39.95, 39.098, 40.078, // Na–Ca
  44.956, 47.867, 50.942, 51.996, 54.938, 55.845, 58.933, 58.693, 63.546, 65.38, // Sc–Zn
  69.723, 72.63, 74.922, 78.971, 79.904, 83.798, 85.468, 87.62, 88.906, 91.224, // Ga–Zr
  92.906, 95.95, 98, 101.07, 102.91, 106.42, 107.87, 112.41, 114.82, 118.71, // Nb–Sn
  121.76, 127.6, 126.904, 131.29, 132.905, 137.33, 138.91, 140.12, 140.91, 144.24, // Sb–Nd
  145, 150.36, 151.96, 157.25, 158.93, 162.5, 164.93, 167.26, 168.93, 173.05, // Pm–Yb
  174.97, 178.49, 180.95, 183.84, 186.21, 190.23, 192.22, 195.08, 196.97, 200.59, // Lu–Hg
  204.38, 207.2, 208.98, 209, 210, 222, 223, 226, 227, 232.04, // Tl–Th
  231.04, 238.03, 237, 244, 243, 247, 247, 251, 252, 257, // Pa–Fm
  258, 259, 262, 267, 268, 269, 270, 277, 278, 281, // Md–Ds
  282, 285, 286, 289, 290, 293, 294, 294, // Rg–Og
];

const MASS_BY_SYMBOL = new Map(ELEMENT_SYMBOLS.map((s, i) => [s, STANDARD_MASSES[i]]));

export function isElement(symbol: string): boolean {
  return MASS_BY_SYMBOL.has(symbol);
}

export function atomicMass(symbol: string): number {
  return MASS_BY_SYMBOL.get(symbol) ?? 0;
}

/** Turn user input such as "cl" or "BR" into a valid symbol, or null. */
export function normalizeSymbol(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const symbol = s[0].toUpperCase() + s.slice(1).toLowerCase();
  return isElement(symbol) ? symbol : null;
}
