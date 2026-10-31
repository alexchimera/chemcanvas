import './style.css';
import { chargeText } from './core/chemistry';
import { aspirin } from './example';
import { ChemCanvasApp, type Readout } from './ui/app';
import { copyText } from './ui/clipboard';
import { ICONS } from './ui/icons';

/** The single-file preview build: the host page owns downloads and the theme. */
const PREVIEW = import.meta.env.MODE === 'artifact';
const GUIDE_KEY = 'chemcanvas:v1:guide';
const THEME_KEY = 'chemcanvas:v1:theme';

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector(selector) as T;

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Storage may be blocked; preferences just won't persist.
    }
  },
};

for (const el of document.querySelectorAll<HTMLElement>('[data-icon]')) {
  el.insertAdjacentHTML('afterbegin', ICONS[el.dataset.icon as keyof typeof ICONS] ?? '');
}

// ——— Toasts ———

const toastEl = $('#toast');
const toastText = $('#toast-text');
const toastAction = $<HTMLButtonElement>('#toast-action');
let toastTimer = 0;
let toastRun: (() => void) | null = null;

function toast(message: string, action?: { label: string; run: () => void }): void {
  toastText.textContent = message;
  toastRun = action?.run ?? null;
  toastAction.hidden = !action;
  toastAction.textContent = action?.label ?? '';
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), action ? 5000 : 2600);
}

toastAction.addEventListener('click', () => {
  toastRun?.();
  toastEl.hidden = true;
});

// ——— Readout ———

const formulaEl = $('#formula');
const weightEl = $('#weight');
const smilesEl = $('#smiles');
const issuesEl = $('#issues');
const exampleTag = $('#example-tag');
const scopeTag = $('#scope-tag');
const copySmiles = $<HTMLButtonElement>('#copy-smiles');
let readoutUpdates = 0;
let shownSmiles = '';

function renderReadout(r: Readout): void {
  if (readoutUpdates++ > 0) exampleTag.hidden = true;
  scopeTag.hidden = r.scope !== 'selection';
  shownSmiles = r.smiles;
  copySmiles.title = r.scope === 'selection' ? 'Copy SMILES of the selection' : 'Copy SMILES';
  copySmiles.setAttribute('aria-label', copySmiles.title);
  formulaEl.replaceChildren();
  copySmiles.disabled = r.atoms === 0;
  if (r.atoms === 0) {
    formulaEl.textContent = 'Empty canvas';
    weightEl.textContent = '';
    smilesEl.textContent = 'Drag anywhere to draw a bond';
    smilesEl.title = '';
    issuesEl.hidden = true;
    return;
  }
  for (const [el, n] of r.formula) {
    formulaEl.append(el);
    if (n > 1) {
      const sub = document.createElement('sub');
      sub.textContent = String(n);
      formulaEl.append(sub);
    }
  }
  if (r.charge) {
    const sup = document.createElement('sup');
    sup.textContent = chargeText(r.charge);
    formulaEl.append(sup);
  }
  weightEl.textContent = `${r.weight.toFixed(2)} g/mol`;
  smilesEl.textContent = r.smiles;
  smilesEl.title = r.smiles;
  issuesEl.hidden = r.valenceIssues === 0;
  issuesEl.textContent = r.valenceIssues === 1 ? '1 valence problem' : `${r.valenceIssues} valence problems`;
}

// ——— App ———

const undoBtn = $<HTMLButtonElement>('#undo');
const redoBtn = $<HTMLButtonElement>('#redo');
const selectBtn = $<HTMLButtonElement>('#select');

const appEl = $('#app');

/** Canvas area not covered by the top bar, readout or gesture guide. */
function freeArea() {
  const box = appEl.getBoundingClientRect();
  const top = $('.topbar').getBoundingClientRect().bottom - box.top + 12;
  let bottom = $('#readout').getBoundingClientRect().top - box.top - 12;
  let left = 16;
  const guideEl = $('#guide');
  if (!guideEl.hidden) {
    const g = guideEl.getBoundingClientRect();
    if (g.width > box.width * 0.6) bottom = Math.min(bottom, g.top - box.top - 12);
    else left = g.right - box.left + 16;
  }
  return { x: left, y: top, width: box.width - left - 16, height: bottom - top };
}

const app = new ChemCanvasApp(appEl, $<HTMLCanvasElement>('#board'), {
  freeArea,
  onChange: renderReadout,
  onHistory(canUndo, canRedo) {
    undoBtn.disabled = !canUndo;
    redoBtn.disabled = !canRedo;
  },
  onTool(tool) {
    selectBtn.setAttribute('aria-pressed', String(tool === 'select'));
  },
  toast,
});

selectBtn.addEventListener('click', () => app.setTool(app.tool === 'select' ? 'draw' : 'select'));
undoBtn.addEventListener('click', () => app.undo());
redoBtn.addEventListener('click', () => app.redo());
$('#fit').addEventListener('click', () => app.fit());
$('#tidy').addEventListener('click', () => app.cleanup());
$('#clear').addEventListener('click', () => app.clear());

async function copy(text: string | null, what: string): Promise<void> {
  if (!text || app.mol.isEmpty) {
    toast('Draw something first');
    return;
  }
  toast((await copyText(text)) ? `${what} copied` : `Copying was blocked; select the text and copy it yourself`);
}

copySmiles.addEventListener('click', () => void copy(shownSmiles, 'SMILES'));

/** Save a file. Left out of the preview build, whose host page doesn't allow downloads. */
const download = PREVIEW
  ? null
  : (name: string, blob: Blob): void => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    };

// ——— Export menu ———

const exportBtn = $<HTMLButtonElement>('#export');
const exportMenu = $('#export-menu');
const fileInput = $<HTMLInputElement>('#mol-file');

function setExportOpen(open: boolean): void {
  exportMenu.hidden = !open;
  exportBtn.setAttribute('aria-expanded', String(open));
}

exportBtn.addEventListener('click', () => setExportOpen(Boolean(exportMenu.hidden)));
document.addEventListener('pointerdown', (e) => {
  const target = e.target as Node;
  if (!exportMenu.hidden && !exportMenu.contains(target) && !exportBtn.contains(target)) setExportOpen(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !exportMenu.hidden) setExportOpen(false);
});

exportMenu.addEventListener('click', (e) => {
  const action = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]')?.dataset.action;
  if (!action) return;
  if (action !== 'open-mol') setExportOpen(false);
  if (action !== 'open-mol' && app.mol.isEmpty) {
    toast('Draw something first');
    return;
  }
  switch (action) {
    case 'copy-smiles':
      void copy(app.smiles(), 'SMILES');
      break;
    case 'copy-mol':
      void copy(app.molfile(), 'Molfile');
      break;
    case 'copy-svg':
      void copy(app.svg(), 'SVG');
      break;
    case 'download-svg':
      download?.('molecule.svg', new Blob([app.svg() ?? ''], { type: 'image/svg+xml' }));
      break;
    case 'download-mol':
      download?.('molecule.mol', new Blob([app.molfile()], { type: 'chemical/x-mdl-molfile' }));
      break;
    case 'download-png':
      if (download) void app.png().then((blob) => blob && download('molecule.png', blob));
      break;
    case 'open-mol':
      fileInput.click();
      break;
  }
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  setExportOpen(false);
  if (file) app.importMolfile(await file.text());
  fileInput.value = '';
});

if (PREVIEW) for (const el of document.querySelectorAll<HTMLElement>('[data-download]')) el.hidden = true;

// ——— Gesture guide ———

const guide = $('#guide');
const guideBtn = $('#guide-toggle');

function setGuide(open: boolean, remember = true): void {
  guide.hidden = !open;
  guideBtn.setAttribute('aria-pressed', String(open));
  if (remember) store.set(GUIDE_KEY, open ? 'open' : 'closed');
}

guideBtn.addEventListener('click', () => setGuide(Boolean(guide.hidden)));
$('#guide-close').addEventListener('click', () => setGuide(false));

// ——— Theme ———

const themeBtn = $('#theme');
if (PREVIEW) {
  themeBtn.hidden = true;
} else {
  const saved = store.get(THEME_KEY);
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
  themeBtn.addEventListener('click', () => {
    const root = document.documentElement;
    const current = root.dataset.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    root.dataset.theme = current === 'dark' ? 'light' : 'dark';
    store.set(THEME_KEY, root.dataset.theme);
  });
}

// ——— Start ———

setGuide(store.get(GUIDE_KEY) !== 'closed', false);
const restored = app.start(aspirin);
exampleTag.hidden = restored;

// A console handle for power users and automated tests.
Object.assign(window, { chemcanvas: app });
