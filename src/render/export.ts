import { boundsOf, type Box } from '../core/geometry';
import type { Molecule } from '../core/molecule';
import { depict, type DepictColors } from './depict';
import { CanvasPainter, SvgPainter } from './painter';

function exportBox(mol: Molecule): Box | null {
  const box = boundsOf(mol.atoms.values());
  if (!box) return null;
  const pad = 0.8;
  return { minX: box.minX - pad, minY: box.minY - pad, maxX: box.maxX + pad, maxY: box.maxY + pad };
}

export function toSvg(mol: Molecule, colors: DepictColors, pxPerUnit = 40): string | null {
  const box = exportBox(mol);
  if (!box) return null;
  const painter = new SvgPainter();
  depict(painter, mol, colors);
  return painter.toString(box, pxPerUnit);
}

export function toPng(mol: Molecule, colors: DepictColors, background: string | null, pxPerUnit = 120): Promise<Blob | null> {
  const box = exportBox(mol);
  if (!box) return Promise.resolve(null);
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil((box.maxX - box.minX) * pxPerUnit);
  canvas.height = Math.ceil((box.maxY - box.minY) * pxPerUnit);
  const ctx = canvas.getContext('2d')!;
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  depict(new CanvasPainter(ctx, pxPerUnit, -box.minX * pxPerUnit, -box.minY * pxPerUnit), mol, colors);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}
