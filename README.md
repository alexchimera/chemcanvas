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
| **Tap an atom** | Element wheel: O, N, S, F, Cl, Br, I, P, H, C, charges, delete, or type any symbol. |
| **Scribble** | Erases whatever it covers (stranded atoms go too). |
| **Hold, then drag** | Moves an atom (it snaps around its neighbour in 15° steps and merges if dropped on another atom). Hold a bond to move the whole molecule. |
| **Hold empty paper, then drag** | Selects: a box, or a lasso once your path curls round (see [Selecting](#selecting)). |
| **Hold and let go** | The menu for what's under your finger: an atom, a bond, the selection or the canvas (see [Menus](#menus)). Right-click does the same with a mouse. |
| **Hold a bond, then shake** | Cleans up that molecule (see [Cleaning up](#cleaning-up)). |
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
| `V` | Select tool on and off |
| `Shift`-drag on empty paper | Select with a box or lasso (add to the selection) |
| `Ctrl/⌘ A`, `C`, `X`, `V`, `D` | Select all, copy, cut, paste (at the pointer), duplicate |
| Arrows (`Shift` for a whole bond), `[` `]` | Nudge the selection, turn it 15° |
| `Delete`, `Esc` | Delete the selection, deselect |
| Right-click, `Shift F10`, menu key | Menu for what's under the pointer |
| Trackpad scroll, `Space`-drag, middle- or right-drag | Pan |
| Mouse wheel, `Ctrl`-scroll, pinch | Zoom |
| `T` | Clean up the selection, the molecule under the pointer, or everything |
| `Ctrl/⌘ Shift K` | Clean up everything |
| `0` | Fit the drawing to the screen |

## Selecting

Hold still on empty paper for a moment (a ring ripples out), then drag. A
fairly straight drag makes a box; curl round and it becomes a lasso, closing
back to where you started. With a mouse, `Shift`-drag skips the wait. The
Select tool (`V`, or the dashed-box button) skips it for everyone: a drag on
empty paper selects, a tap on a molecule selects all of it, and a drag on a
molecule picks it up and moves it.

A selection is highlighted and framed:

- drag anything inside the frame to move it, or shake it to clean it up;
- drag the round handle above the frame to turn it (it clicks to 15° steps,
  with the angle shown as you go);
- the bar under the frame turns it 90°, flips it, duplicates it, cleans it up
  or deletes it, and its `…` opens the selection menu.

Flips turn the structure over rather than mirroring it: wedges become hashes
(and hashes wedges) at every stereocentre that turns over with all its
neighbours, so the drawing changes but the compound doesn't. While something
is selected, the readout at the bottom shows its formula, weight and SMILES.

## Menus

Right-click, or on a phone hold and let go, for a menu of what you can do to
the thing under your finger. On a desktop it pops up at the pointer with the
keyboard shortcuts alongside; on a phone it slides up from the bottom with
finger-sized rows.

| Menu | Holds |
| --- | --- |
| Atom | Element (C, N, O, S, P, F, Cl, Br, I, H, or type any), charge, select molecule, clean up molecule, analysis, delete |
| Bond | Single, double, triple, wedge, hash, wavy; swap a wedge's ends; select molecule, clean up molecule, analysis, delete |
| Selection | Turn 90° either way, flip either way; cut, copy, duplicate; clean up; analysis; copy as SMILES, Molfile or SVG; select all, deselect, delete |
| Canvas | Paste here, add an atom here, select all, clean up everything, analysis, fit to screen, undo, redo, clear |

**Analysis** opens a panel modelled on ChemDraw's Analysis window, for the
selection (or the whole drawing when nothing is selected), and keeps up as
you edit: molecular formula, exact (monoisotopic) mass, molecular weight, the
calculated isotope pattern as m/z with relative heights, and elemental
analysis. For aspirin that's C9H8O4, 180.0423, 180.16,
180.0423 (100.0%), 181.0457 (10.0%), 182.0474 (1.3%), and C, 60.00; H, 4.48;
O, 35.52. Its copy button gives the same as plain text for a notebook or SI.

Copied structures go on the clipboard as Molfiles, so they paste into other
editors as well as back into ChemCanvas; a copy pasted here keeps its place on
the hex paper.

## Cleaning up

When a structure has drifted (atoms dragged about, molecules joined at odd
angles, a Molfile with its own ideas about geometry), the wand button redraws
everything with ideal geometry and the atoms glide into place. `T`, the bond
wheel's wand, or holding a bond and shaking it does the same for one molecule.
Undo puts it all back.

Clean-up gives unit bonds, regular rings (fused, spiro and peri-fused systems
included), 120° zig-zags, straight alkynes and allenes, and crosses for
quaternary carbons. Bridged systems get their usual drawings: norbornane with
its bridge inside the hexagon, bicyclo[2.2.2]octane with its bridge across the
middle. It keeps what the drawing says:

- substituents stay on the side of the ring or chain they were drawn on;
- cis double bonds stay cis and trans stay trans;
- wedged and hashed stereocentres keep their configuration, even when a branch
  has to be mirrored to stop it overlapping another (its wedges are swapped);
- the molecule stays where it was and roughly the way round it was, squared
  onto the 30° grid and the hex lattice, and is moved off any molecule it
  would now overlap.

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
  core/        molecule graph, valence and implicit H, rings (SSSR), placement geometry, clean-up layout,
               selections (pick, turn, flip, copy), analysis (exact mass, isotopes), edits, history
  gestures/    stroke analysis, chain walker, ring placement, erase, and the plans they produce
  io/          SMILES writer, Molfile reader/writer
  render/      depiction (ACS-style), canvas and SVG painters, export
  ui/          interaction state machine, renderer, element wheel, context menus, selection bar, analysis panel
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
- **Clean-up** (`core/layout.ts`): ring systems are built from regular
  polygons (bending the leftover atoms of a ring that can't be regular round
  an arc of unit bonds) and placed as rigid units; everything else grows out
  from the largest ring system along the tree of acyclic bonds, each bond
  taking the ideal direction nearest the drawn one without reordering
  substituents around any atom. Overlaps are then removed by mirroring
  branches across single bonds, and the result is fitted back onto the drawing
  by least-squares rotation.
- **One press, several meanings** (`ui/app.ts`). Every press starts out
  pending. Moving past a few pixels makes it a stroke (or a box, or a move,
  depending on whether it began on the selection or with the Select tool);
  letting go makes it a tap; holding still for 0.42 s makes it a hold, which
  then becomes a menu on release or a move or selection on drag. A second
  finger turns any of these into a pinch without leaving anything behind.
- **Isotope patterns** (`core/analysis.ts`) are built atom by atom from the
  NIST isotope tables, binned by mass number with the mean mass kept per bin,
  and pruned below 10⁻⁹ of the tallest peak so large molecules stay cheap.
- **Hex paper.** The background is a honeycomb lattice with unit-length edges.
  Chains started on empty paper and upright benzene rings snap onto it, so
  separately drawn structures line up.
- **Depiction** follows ACS 1996 proportions: 18% double-bond spacing, inner
  ring double bonds trimmed to the angle bisector, centred C=O, bonds clipped
  at atom labels, implicit hydrogens placed away from the bonds (`OH`, `H₂N`).

## Limitations

- SMILES output is Kekulé and non-canonical, and does not encode wedge/hash stereochemistry yet.
- SMILES import is not supported yet; Molfiles can be imported.
- No reaction arrows or text annotations yet.
- Exact masses and isotope patterns cover 37 common elements, from H to Bi.
  Any other element falls back to its average mass, and the panel marks those
  figures with ≈.
