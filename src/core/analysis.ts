import { formulaOf, formulaText, formulaWeight, hillOrder, type Formula } from './chemistry';
import { atomicMass } from './elements';
import type { Molecule } from './molecule';

/**
 * Isotope masses (u) and natural abundances (%), from the NIST/IUPAC tables,
 * for the elements a structure drawing is likely to contain.
 */
const ISOTOPES: Record<string, [mass: number, abundance: number][]> = {
  H: [[1.00782503207, 99.9885], [2.0141017778, 0.0115]],
  Li: [[6.015122795, 7.59], [7.01600455, 92.41]],
  B: [[10.012937, 19.9], [11.0093054, 80.1]],
  C: [[12, 98.93], [13.0033548378, 1.07]],
  N: [[14.0030740048, 99.636], [15.0001088982, 0.364]],
  O: [[15.99491461956, 99.757], [16.9991317, 0.038], [17.999161, 0.205]],
  F: [[18.99840322, 100]],
  Na: [[22.9897692809, 100]],
  Mg: [[23.9850417, 78.99], [24.98583692, 10], [25.982592929, 11.01]],
  Al: [[26.98153863, 100]],
  Si: [[27.9769265325, 92.223], [28.9764947, 4.685], [29.97377017, 3.092]],
  P: [[30.97376163, 100]],
  S: [[31.972071, 94.99], [32.97145876, 0.75], [33.9678669, 4.25], [35.96708076, 0.01]],
  Cl: [[34.96885268, 75.76], [36.96590259, 24.24]],
  K: [[38.96370668, 93.2581], [39.96399848, 0.0117], [40.96182576, 6.7302]],
  Ca: [[39.96259098, 96.941], [41.95861801, 0.647], [42.9587666, 0.135], [43.9554818, 2.086], [45.9536926, 0.004], [47.952534, 0.187]],
  Mn: [[54.9380451, 100]],
  Fe: [[53.9396105, 5.845], [55.9349375, 91.754], [56.935394, 2.119], [57.9332756, 0.282]],
  Co: [[58.933195, 100]],
  Ni: [[57.9353429, 68.077], [59.9307864, 26.223], [60.931056, 1.1399], [61.9283451, 3.6346], [63.927966, 0.9255]],
  Cu: [[62.9295975, 69.15], [64.9277895, 30.85]],
  Zn: [[63.9291422, 48.268], [65.9260334, 27.975], [66.9271273, 4.102], [67.9248442, 19.024], [69.9253193, 0.631]],
  Ge: [[69.9242474, 20.84], [71.9220758, 27.54], [72.9234589, 7.73], [73.9211778, 36.28], [75.9214026, 7.61]],
  As: [[74.9215965, 100]],
  Se: [[73.9224764, 0.89], [75.9192136, 9.37], [76.919914, 7.63], [77.9173091, 23.77], [79.9165213, 49.61], [81.9166994, 8.73]],
  Br: [[78.9183371, 50.69], [80.9162906, 49.31]],
  Rh: [[102.905504, 100]],
  Pd: [[101.905609, 1.02], [103.904036, 11.14], [104.905085, 22.33], [105.903486, 27.33], [107.903892, 26.46], [109.905153, 11.72]],
  Ag: [[106.905097, 51.839], [108.904752, 48.161]],
  Sn: [
    [111.904818, 0.97], [113.902779, 0.66], [114.903342, 0.34], [115.901741, 14.54], [116.902952, 7.68],
    [117.901603, 24.22], [118.903308, 8.59], [119.902195, 32.58], [121.903439, 4.63], [123.905274, 5.79],
  ],
  Te: [
    [119.90402, 0.09], [121.9030439, 2.55], [122.90427, 0.89], [123.9028179, 4.74], [124.9044307, 7.07],
    [125.9033117, 18.84], [127.9044631, 31.74], [129.9062244, 34.08],
  ],
  I: [[126.904473, 100]],
  Cs: [[132.905451933, 100]],
  Pt: [[189.959932, 0.014], [191.961038, 0.782], [193.96268, 32.967], [194.964791, 33.832], [195.964951, 25.242], [197.967893, 7.163]],
  Au: [[196.9665687, 100]],
  Hg: [[195.965833, 0.15], [197.966769, 9.97], [198.96828, 16.87], [199.968326, 23.1], [200.970302, 13.18], [201.970643, 29.86], [203.973494, 6.87]],
  Bi: [[208.9803987, 100]],
};

const ELECTRON_MASS = 0.000548579909;

export interface Peak {
  /** m/z of the peak: mass over |charge| (just the mass for a neutral structure). */
  mz: number;
  /** Height relative to the tallest peak, in percent. */
  relative: number;
}

export interface Analysis {
  formula: Formula;
  formulaText: string;
  /** Monoisotopic mass: the most abundant isotope of every element, less the electrons of a positive charge. */
  exactMass: number;
  /** Average molecular weight from standard atomic weights. */
  weight: number;
  /** Calculated isotope pattern, peaks of 1% or more. */
  peaks: Peak[];
  /** Percent by mass, in Hill order. */
  composition: { element: string; percent: number }[];
  /** True when some element has no isotope data and its average mass stood in. */
  approximate: boolean;
}

/** Formula, exact mass, isotope pattern and elemental analysis, as ChemDraw's Analysis window gives them. */
export function analyze(mol: Molecule, atoms?: Iterable<number>): Analysis {
  const formula = formulaOf(mol, atoms);
  const counts = formula.counts;
  const weight = formulaWeight(counts);
  let approximate = false;
  let mono = 0;
  // Isotope pattern by nominal mass: key = total mass number, value = probability and mean mass.
  let pattern = new Map<number, { p: number; m: number }>([[0, { p: 1, m: 0 }]]);
  for (const [el, n] of counts) {
    const table = ISOTOPES[el];
    if (!table) {
      approximate = true;
      mono += atomicMass(el) * n;
      pattern = shift(pattern, atomicMass(el) * n);
      continue;
    }
    mono += table.reduce((best, iso) => (iso[1] > best[1] ? iso : best))[0] * n;
    for (let k = 0; k < n; k++) pattern = convolve(pattern, table);
  }
  const z = formula.charge;
  const exactMass = mono - z * ELECTRON_MASS;
  const tallest = Math.max(...[...pattern.values()].map((v) => v.p));
  const peaks = [...pattern.values()]
    .map((v) => ({ mz: (v.m - z * ELECTRON_MASS) / Math.max(1, Math.abs(z)), relative: (100 * v.p) / tallest }))
    .filter((pk) => pk.relative >= 1)
    .sort((a, b) => b.relative - a.relative)
    .slice(0, 6)
    .sort((a, b) => a.mz - b.mz);
  const composition = hillOrder(counts).map(([element, n]) => ({ element, percent: weight > 0 ? (100 * atomicMass(element) * n) / weight : 0 }));
  return { formula, formulaText: formulaText(formula), exactMass, weight, peaks, composition, approximate };
}

/** Add one atom with the given isotopes to a distribution, binned by mass number. */
function convolve(dist: Map<number, { p: number; m: number }>, isotopes: [number, number][]): Map<number, { p: number; m: number }> {
  const out = new Map<number, { p: number; m: number }>();
  let max = 0;
  for (const [key, v] of dist) {
    for (const [mass, abundance] of isotopes) {
      const p = v.p * (abundance / 100);
      const k = key + Math.round(mass);
      const bin = out.get(k);
      // m accumulates p-weighted mass and is normalised below.
      if (bin) {
        bin.m += p * (v.m + mass);
        bin.p += p;
      } else out.set(k, { p, m: p * (v.m + mass) });
    }
  }
  for (const bin of out.values()) {
    bin.m /= bin.p;
    max = Math.max(max, bin.p);
  }
  // Drop vanishing isotopologues so big molecules stay cheap.
  for (const [k, bin] of out) if (bin.p < max * 1e-9) out.delete(k);
  return out;
}

function shift(dist: Map<number, { p: number; m: number }>, mass: number): Map<number, { p: number; m: number }> {
  return new Map([...dist].map(([k, v]) => [k + Math.round(mass), { p: v.p, m: v.m + mass }]));
}

/** The plain-text block ChemDraw users paste into lab notebooks and SI. */
export function analysisText(a: Analysis): string {
  const peaks = a.peaks.map((pk) => `${pk.mz.toFixed(4)} (${pk.relative.toFixed(1)}%)`).join(', ');
  const ea = a.composition.map((c) => `${c.element}, ${c.percent.toFixed(2)}`).join('; ');
  return [
    `Formula: ${a.formulaText}`,
    `Exact Mass: ${a.exactMass.toFixed(4)}`,
    `Molecular Weight: ${a.weight.toFixed(2)}`,
    `m/z: ${peaks}`,
    `Elemental Analysis: ${ea}`,
  ].join('\n');
}
