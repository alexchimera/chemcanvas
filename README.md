# ChemCanvas

A web canvas for sketching 2D molecular structures with fluid gestures. You draw
the way you would on paper: drag out a chain, loop a ring, scribble something
out. Each stroke is read as it happens and cleaned up into a properly laid-out
skeletal formula, with a live preview of what it will become before you lift
your finger.

Works with a mouse, trackpad, pen or finger. No dependencies at runtime.

## Gestures

| Gesture | Result |
| --- | --- |
| **Drag** | A short flick is one bond; keep going for a zig-zag chain that follows your path. Start on an atom to grow from it, end on an atom to connect to it. |
| **Draw a loop** | A ring. A smooth circle gives a six-membered ring; draw 3–8 corners for other sizes. Loop over a bond to fuse a ring onto it, through a chain end to put the ring there. |
| **Circle inside a ring** (or tap inside it) | Adds alternating double bonds (Kekulé form); do it again to remove them. Pyrrole/furan-type heteroatoms are left alone. |
| **Retrace a bond** | Raises its order: single → double → triple. |
| **Tap a bond** | Cycles single → double → triple. |
| **Hold a bond, let go** | Bond wheel: single, double, triple, wedge, hash, wavy, delete. Choosing wedge again flips it. |
| **Tap an atom** | Element wheel: O, N, S, F, Cl, Br, I, P, H, C, charges, delete, or type any symbol. |
| **Scribble** | Erases whatever it covers (stranded atoms go too). |
| **Hold, then drag** | Moves an atom (it snaps around its neighbour in 15° steps and merges if dropped on another atom). Hold a bond to move the whole molecule. |
| **Double-tap empty paper** | Adds a single atom. |
| **Pinch / two-finger drag** | Zoom and pan. |
| **Two-finger tap** / three-finger tap | Undo / redo. |

With a stylus, a single finger pans instead of drawing, so a resting palm does no harm.

### Keyboard

| Keys | Action |
| --- | --- |
| Hover an atom + `C` `N` `O` `S` `P` `F` `H` `I`, `L` (Cl), `B` (Br) | Set the element |
| Hover an atom + `+` / `−` | Change the charge |
| Hover a bond + `1` `2` `3`, `W`, `H` | Bond order, wedge, hash |
| Hover + `Delete` / `Backspace` | Delete it |
| Element wheel open + type a symbol + `Enter` | Any element, e.g. `Si` |
| `Ctrl/⌘ Z`, `Ctrl/⌘ Shift Z` (or `Ctrl Y`) | Undo, redo |
| Trackpad scroll, `Space`-drag, middle- or right-drag | Pan |
| Mouse wheel, `Ctrl`-scroll, pinch | Zoom |
| `0` | Fit the drawing to the screen |

## Output

The readout at the bottom shows the molecular formula (Hill order), molecular
weight and a SMILES string as you draw, and flags impossible valences. The
export menu copies or downloads SMILES, an MDL Molfile (V2000), SVG or PNG, and
imports Molfiles (open a file or paste one anywhere). The drawing is saved in
the browser between visits.

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
```

```bash
npm test           # unit tests (Vitest)
npm run typecheck
npm run build      # static site in dist/
```

`npm run smoke` drives the running dev server in a real browser with mouse and
touch input. It needs Playwright (`npm i -D playwright && npx playwright install chromium`).

`npm run build:artifact` produces `dist-artifact/chemcanvas.html`, a single
self-contained page (inlined CSS and JS) without file downloads or a theme
toggle, for embedding in a host page that controls those.

## How it works

```
src/
  core/        molecule graph, valence and implicit H, rings (SSSR), placement geometry, edits, history
  gestures/    stroke analysis, chain walker, ring placement, erase, and the plans they produce
  io/          SMILES writer, Molfile reader/writer
  render/      depiction (ACS-style), canvas and SVG painters, export
  ui/          interaction state machine, renderer, element/bond wheels
```

- **Strokes become plans.** `gestures/interpret.ts` classifies the stroke so far
  as a scribble, a closed loop or a path, and returns a *plan* (atoms and bonds
  to add, bonds to change, or things to erase). Plans are pure data: while the
  pointer is down the canvas applies the plan to a scratch copy of the molecule
  and draws the new parts in blue, so the preview always matches the result.
- **Chains** (`gestures/chain.ts`): every plausible first bond (the 30° grid,
  the ideal directions around the start atom, existing bonds to retrace) is
  walked greedily along the stroke, turning ±60° each bond with one bond of
  lookahead, and the chain whose shape best matches the stroke wins. A straight
  drag therefore becomes a zig-zag, and a curved drag bends with your finger.
- **Rings** (`gestures/ring.ts`, `gestures/stroke.ts`): closed loops are found
  even with overshoot or a lead-in tail; corners are counted from the turning
  profile to pick the ring size; the ring is then fused onto a bond, grown
  through an atom, hung off a nearby atom, or placed on its own.
- **Hex paper.** The background is a honeycomb lattice with unit-length edges.
  Chains started on empty paper and upright benzene rings snap onto it, so
  separately drawn structures line up.
- **Depiction** follows ACS 1996 proportions: 18% double-bond spacing, inner
  ring double bonds trimmed to the angle bisector, centred C=O, bonds clipped
  at atom labels, implicit hydrogens placed away from the bonds (`OH`, `H₂N`).

## Limitations

- SMILES output is Kekulé and non-canonical, and does not encode wedge/hash stereochemistry yet.
- SMILES import is not supported (it needs 2D coordinate generation); Molfiles can be imported.
- No reaction arrows, text annotations or multi-select yet.
