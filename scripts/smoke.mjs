// Browser smoke test: drives the running app with real mouse and touch input.
//
//   npm run dev            (in another terminal)
//   npm run smoke          (or: node scripts/smoke.mjs http://localhost:5173/)
//
// Needs Playwright with Chromium: npm i -D playwright && npx playwright install chromium
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright is not installed. Run: npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

const url = process.argv[2] ?? 'http://localhost:5173/';
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const browser = await chromium.launch();

// ——— Desktop, mouse and keyboard ———
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForTimeout(300);
  const smiles = () => page.evaluate(() => window.chemcanvas.smiles());
  const stroke = async (pts, steps = 4) => {
    await page.mouse.move(...pts[0]);
    await page.mouse.down();
    for (const p of pts.slice(1)) await page.mouse.move(...p, { steps });
    await page.mouse.up();
    await page.waitForTimeout(60);
  };
  const ring = (cx, cy, r, n, sweep = 2.05) =>
    Array.from({ length: n + 1 }, (_, k) => {
      const t = -Math.PI / 2 + (k / n) * Math.PI * sweep;
      return [cx + Math.cos(t) * r, cy + Math.sin(t) * r];
    });

  check('opens on the aspirin example', (await smiles()) === 'CC(=O)OC1=CC=CC=C1C(=O)O', await smiles());
  await page.click('#guide-close');
  await page.click('#clear');

  await stroke([[420, 420], [560, 418], [700, 420]], 12);
  check('a straight drag makes a zig-zag chain', /^C{6,8}$/.test(await smiles()), await smiles());

  await stroke(ring(950, 420, 44, 40), 2);
  check('a circle makes a six-membered ring', (await smiles()).endsWith('.C1CCCCC1'), await smiles());

  // The ring snaps onto the hex lattice, so tap its actual centre.
  const centre = await page.evaluate(() => {
    const app = window.chemcanvas;
    const ring = [...app.mol.atoms.values()].slice(-6);
    return app.view.toScreen({ x: ring.reduce((s, a) => s + a.x, 0) / 6, y: ring.reduce((s, a) => s + a.y, 0) / 6 });
  });
  await page.mouse.click(centre.x, centre.y);
  check('tapping inside a ring adds alternating double bonds', (await smiles()).endsWith('.C1=CC=CC=C1'), await smiles());

  await stroke(ring(950, 640, 44, 5, 2), 6);
  check('a pentagon makes a five-membered ring', (await smiles()).endsWith('.C1CCCC1'), await smiles());

  const first = await page.evaluate(() => window.chemcanvas.view.toScreen([...window.chemcanvas.mol.atoms.values()][0]));
  await page.mouse.move(first.x, first.y);
  await page.keyboard.press('o');
  check('hovering an atom and pressing O sets oxygen', (await smiles()).includes('O'), await smiles());
  await page.keyboard.press('Control+z');
  check('Ctrl+Z undoes', !(await smiles()).includes('O'), await smiles());

  await page.mouse.click(first.x, first.y);
  await page.click('.wheel-item[aria-label="Change to N"]');
  check('the element wheel sets nitrogen', (await smiles()).includes('N'), await smiles());

  // Knock an atom out of place by holding and dragging it, then tidy with the wand.
  const victim = await page.evaluate(() => window.chemcanvas.view.toScreen([...window.chemcanvas.mol.atoms.values()][3]));
  await page.mouse.move(victim.x, victim.y);
  await page.mouse.down();
  await page.waitForTimeout(550);
  await page.mouse.move(victim.x + 40, victim.y + 35, { steps: 6 });
  await page.mouse.up();
  const bondSpread = () =>
    page.evaluate(() => {
      const m = window.chemcanvas.mol;
      const l = [...m.bonds.values()].map((b) => Math.hypot(m.atoms.get(b.a).x - m.atoms.get(b.b).x, m.atoms.get(b.a).y - m.atoms.get(b.b).y));
      return Math.max(...l) - Math.min(...l);
    });
  const distorted = await bondSpread();
  await page.click('#tidy');
  await page.waitForTimeout(500);
  check('the wand straightens a distorted molecule', distorted > 0.1 && (await bondSpread()) < 1e-6, `bond length spread ${distorted.toFixed(2)} → ${(await bondSpread()).toExponential(1)}`);

  // Right-click opens the menu for what's under the pointer.
  const atomAt = (k) => page.evaluate((i) => window.chemcanvas.view.toScreen([...window.chemcanvas.mol.atoms.values()][i]), k);
  const a2 = await atomAt(2);
  await page.mouse.click(a2.x, a2.y, { button: 'right' });
  await page.waitForTimeout(150);
  check('right-click on an atom opens its menu', /atom$/.test((await page.locator('.ctx-head b').first().textContent()) ?? ''));
  await page.keyboard.press('Escape');

  // Select everything, flip it with the selection bar: the drawing changes, the compound doesn't.
  await page.keyboard.press('Control+a');
  await page.waitForTimeout(100);
  const beforeFlip = await smiles();
  await page.click('.selbar [data-key="flip-h"]');
  check('the selection bar flips the selection without changing the compound', (await smiles()) === beforeFlip, await smiles());
  await page.click('.selbar [data-key="duplicate"]');
  check('Duplicate copies the selection', (await smiles()).split('.').length === 2 * beforeFlip.split('.').length, await smiles());
  await page.click('.selbar [data-key="delete"]');
  check('Delete removes the copy', (await smiles()) === beforeFlip);
  await page.keyboard.press('Escape');

  // Shift-drag on empty paper draws a selection box.
  const ringBox = await page.evaluate(() => {
    const app = window.chemcanvas;
    const pts = [...app.mol.atoms.values()].slice(-5).map((a) => app.view.toScreen(a));
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    return { minX: Math.min(...xs) - 20, minY: Math.min(...ys) - 20, maxX: Math.max(...xs) + 20, maxY: Math.max(...ys) + 20 };
  });
  await page.keyboard.down('Shift');
  await stroke([[ringBox.minX, ringBox.minY], [ringBox.maxX, ringBox.maxY]], 10);
  await page.keyboard.up('Shift');
  const picked = await page.evaluate(() => window.chemcanvas.selection.size);
  check('Shift-drag selects with a box', picked >= 5, `${picked} atoms`);

  // The ChemDraw-style analysis of the selection.
  const cyclopentane = await page.evaluate(() => {
    const app = window.chemcanvas;
    app.select(app.mol.fragmentOf([...app.mol.atoms.keys()].at(-1)));
    app.showAnalysis();
    return document.querySelector('#analysis').textContent;
  });
  check('Analysis shows the exact mass of the selection', cyclopentane.includes('70.0783'), cyclopentane.replace(/\s+/g, ' ').slice(0, 90));
  await page.keyboard.press('Escape');

  const svgOk = await page.evaluate(() => {
    const doc = new DOMParser().parseFromString(window.chemcanvas.svg(), 'image/svg+xml');
    return !doc.querySelector('parsererror');
  });
  check('SVG export is well-formed', svgOk);
  check('no page errors (desktop)', errors.length === 0, errors.join(' | '));
  await page.close();
}

// ——— Two people in one shared drawing ———
{
  const context = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  const a = await context.newPage();
  const b = await context.newPage();
  const errors = [];
  for (const p of [a, b]) p.on('pageerror', (e) => errors.push(String(e)));
  await a.goto(url);
  await a.evaluate(() => localStorage.clear());
  await a.reload();
  await a.waitForTimeout(300);
  await a.click('#guide-close');
  await a.click('#share');
  await a.click('#room-start');
  await a.waitForFunction(() => document.querySelector('#room-status')?.dataset.status === 'live', null, { timeout: 5000 });
  const link = await a.inputValue('#room-link');
  check('starting a shared drawing gives a link', /[?&]room=[a-z0-9]{6}$/.test(link), link);
  await b.goto(link);
  const synced = (n) => b.waitForFunction((k) => window.chemcanvas.mol.atoms.size === k, n, { timeout: 5000 }).then(() => true, () => false);
  check('opening the link shows the same drawing', await synced(await a.evaluate(() => window.chemcanvas.mol.atoms.size)));
  await a.click('#share');
  await a.mouse.move(300, 600);
  await a.mouse.down();
  for (let x = 310; x <= 520; x += 10) await a.mouse.move(x, 600);
  await a.mouse.up();
  check('a chain drawn by one person appears for the other', await synced(await a.evaluate(() => window.chemcanvas.mol.atoms.size)));
  check('no page errors (shared)', errors.length === 0, errors.join(' | '));
  await context.close();
}

// ——— Phone, touch ———
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForTimeout(300);
  check('no horizontal scrolling on a phone', !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)));
  await page.tap('#guide-close');
  const cdp = await context.newCDPSession(page);
  const touch = (type, points) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  const atoms = () => page.evaluate(() => window.chemcanvas.mol.atoms.size);

  // Small phones clear the canvas from the canvas menu: hold empty paper, let go.
  await touch('touchStart', [[340, 640]]);
  await page.waitForTimeout(520);
  await touch('touchEnd', []);
  await page.waitForTimeout(200);
  await page.tap('.ctx-item:has-text("Clear canvas")');
  check('the canvas menu clears the canvas on a phone', (await atoms()) === 0);

  await touch('touchStart', [[60, 380]]);
  for (let x = 70; x <= 330; x += 10) await touch('touchMove', [[x, 380]]);
  await touch('touchEnd', []);
  check('a one-finger drag draws a chain', (await atoms()) >= 6, `${await atoms()} atoms`);

  await touch('touchStart', [[150, 600], [230, 600]]);
  await touch('touchEnd', []);
  await page.waitForTimeout(100);
  check('a two-finger tap undoes', (await atoms()) === 0);

  await touch('touchStart', [[120, 600], [190, 600], [260, 600]]);
  await touch('touchEnd', []);
  await page.waitForTimeout(100);
  check('a three-finger tap redoes', (await atoms()) >= 6);

  const a = await page.evaluate(() => window.chemcanvas.view.toScreen([...window.chemcanvas.mol.atoms.values()][0]));
  await page.touchscreen.tap(a.x, a.y);
  await page.waitForTimeout(300);
  check('tapping an atom keeps the element wheel open', (await page.locator('.wheel-item').count()) > 0);
  await touch('touchStart', [[200, 250]]);
  await touch('touchEnd', []);
  await page.waitForTimeout(400);

  // Hold and let go: the menu, as a sheet along the bottom edge.
  await touch('touchStart', [[a.x, a.y]]);
  await page.waitForTimeout(520);
  await touch('touchEnd', []);
  await page.waitForTimeout(200);
  check('hold and let go on an atom opens a bottom sheet', (await page.locator('.ctx.sheet:not([hidden])').count()) === 1);
  await touch('touchStart', [[195, 40]]);
  await touch('touchEnd', []);
  await page.waitForTimeout(200);

  // Hold empty paper, then drag: a selection box.
  const chain = await page.evaluate(() => {
    const app = window.chemcanvas;
    const pts = [...app.mol.atoms.values()].map((p) => app.view.toScreen(p));
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    return { minX: Math.min(...xs) - 16, minY: Math.min(...ys) - 24, maxX: Math.max(...xs) + 16, maxY: Math.max(...ys) + 24 };
  });
  await touch('touchStart', [[chain.minX, chain.minY]]);
  await page.waitForTimeout(520);
  for (let k = 1; k <= 8; k++) await touch('touchMove', [[chain.minX + ((chain.maxX - chain.minX) * k) / 8, chain.minY + ((chain.maxY - chain.minY) * k) / 8]]);
  await touch('touchEnd', []);
  await page.waitForTimeout(150);
  check('hold and drag on empty paper selects', (await page.evaluate(() => window.chemcanvas.selection.size)) === (await atoms()));
  check('no page errors (phone)', errors.length === 0, errors.join(' | '));
  await context.close();
}

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
