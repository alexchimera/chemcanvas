// Turn the `vite build --mode artifact` output into one self-contained page:
// the bundled CSS and JS are inlined, and only the page content is kept (the
// hosting page supplies the <html>/<head>/<body> skeleton).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'dist-artifact';
const html = readFileSync(join(dir, 'index.html'), 'utf8');

function bundled(pattern) {
  const match = html.match(pattern);
  if (!match) throw new Error(`Could not find ${pattern} in ${dir}/index.html`);
  return readFileSync(join(dir, match[1]), 'utf8');
}

const js = bundled(/<script type="module" crossorigin src="\.\/(assets\/[^"]+\.js)"><\/script>/);
const css = bundled(/<link rel="stylesheet" crossorigin href="\.\/(assets\/[^"]+\.css)">/);
const title = html.match(/<title>[\s\S]*?<\/title>/)[0];
const fonts = [...html.matchAll(/<link rel="(?:preconnect|stylesheet)" href="https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>/g)].map(
  (m) => m[0],
);
const body = html
  .match(/<body>([\s\S]*)<\/body>/)[1]
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .trim();

const page = [
  title,
  ...fonts,
  `<style>${css}</style>`,
  body,
  `<script type="module">${js.replace(/<\/script/gi, '<\\/script')}</script>`,
].join('\n');

const out = join(dir, 'chemcanvas.html');
writeFileSync(out, page);
console.log(`Wrote ${out} (${(page.length / 1024).toFixed(1)} kB)`);
