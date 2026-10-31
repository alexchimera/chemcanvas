import { analysisText, type Analysis } from '../core/analysis';
import { chargeText, hillOrder } from '../core/chemistry';
import { ICONS } from './icons';

/**
 * A floating panel modelled on ChemDraw's Analysis window: formula, exact
 * mass, molecular weight, isotope pattern and elemental analysis of the
 * selection, or of everything when nothing is selected.
 */
export class AnalysisCard {
  private readonly el: HTMLElement;
  private readonly scope: HTMLElement;
  private readonly body: HTMLElement;
  private text = '';

  constructor(host: HTMLElement, copy: (text: string) => void) {
    this.el = document.createElement('section');
    this.el.className = 'card analysis';
    this.el.id = 'analysis';
    this.el.setAttribute('aria-labelledby', 'analysis-title');
    this.el.hidden = true;

    const head = document.createElement('div');
    head.className = 'card-head';
    const title = document.createElement('h2');
    title.id = 'analysis-title';
    title.textContent = 'Analysis';
    this.scope = document.createElement('span');
    this.scope.className = 'card-scope';
    const copyBtn = iconButton('copy', 'Copy as text');
    copyBtn.addEventListener('click', () => this.text && copy(this.text));
    const closeBtn = iconButton('close', 'Close analysis');
    closeBtn.addEventListener('click', () => this.hide());
    head.append(title, this.scope, copyBtn, closeBtn);

    this.body = document.createElement('dl');
    this.el.append(head, this.body);
    host.append(this.el);
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  show(analysis: Analysis | null, scope: string): void {
    this.el.hidden = false;
    this.scope.textContent = scope;
    this.body.replaceChildren();
    if (!analysis) {
      this.text = '';
      this.body.append(row('', 'Nothing drawn yet'));
      return;
    }
    this.text = analysisText(analysis);
    const formula = document.createElement('span');
    for (const [el, n] of hillOrder(analysis.formula.counts)) {
      formula.append(el);
      if (n > 1) formula.append(tag('sub', String(n)));
    }
    if (analysis.formula.charge) formula.append(tag('sup', chargeText(analysis.formula.charge)));
    const approx = analysis.approximate ? '≈ ' : '';
    const peaks = document.createElement('span');
    analysis.peaks.forEach((pk, i) => {
      if (i) peaks.append(document.createElement('br'));
      peaks.append(`${approx}${pk.mz.toFixed(4)} `, tag('small', `(${pk.relative.toFixed(1)}%)`));
    });
    this.body.append(
      row('Formula', formula),
      row('Exact mass', `${approx}${analysis.exactMass.toFixed(4)}`),
      row('Molecular weight', analysis.weight.toFixed(2)),
      row('m/z', peaks),
      row('Elemental analysis', analysis.composition.map((c) => `${c.element}, ${c.percent.toFixed(2)}`).join('; ')),
    );
  }

  hide(): void {
    this.el.hidden = true;
  }
}

function iconButton(icon: keyof typeof ICONS, label: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'icon-btn';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.innerHTML = ICONS[icon];
  return btn;
}

function tag(name: string, text: string): HTMLElement {
  const el = document.createElement(name);
  el.textContent = text;
  return el;
}

function row(term: string, value: string | Node): HTMLElement {
  const div = document.createElement('div');
  const dt = document.createElement('dt');
  dt.textContent = term;
  const dd = document.createElement('dd');
  dd.append(value);
  div.append(dt, dd);
  return div;
}
