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

  const svgOk = await page.evaluate(() => {
    const doc = new DOMParser().parseFromString(window.chemcanvas.svg(), 'image/svg+xml');
    return !doc.querySelector('parsererror');
  });
  check('SVG export is well-formed', svgOk);
  check('no page errors (desktop)', errors.length === 0, errors.join(' | '));
  await page.close();
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
  const cdp = await context.newCDPSession(page);
  const touch = (type, points) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  const atoms = () => page.evaluate(() => window.chemcanvas.mol.atoms.size);

  check('no horizontal scrolling on a phone', !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)));
  await page.tap('#guide-close');
  await page.tap('#clear');

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
  check('no page errors (phone)', errors.length === 0, errors.join(' | '));
  await context.close();
}

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
