/** Inline SVG icons (24-unit grid, stroked with currentColor). */
const icon = (body: string, filled = false) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="${filled ? 'currentColor' : 'none'}" ` +
  `stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICONS = {
  undo: icon('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  redo: icon('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
  fit: icon('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><path d="M9.5 12h5M12 9.5v5"/>'),
  trash: icon('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  share: icon('<path d="M12 15V3M7.5 7.5 12 3l4.5 4.5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>'),
  guide: icon('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .8-1 1.5v.4"/><path d="M12 17.2h.01" stroke-width="2.4"/>'),
  moon: icon('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>'),
  tidy: icon('<path d="m4 20 11-11"/><path d="m13.5 7.5 3 3"/><path d="M18.5 3v3.5M16.75 4.75h3.5M20 10.5v2.5M18.75 11.75h2.5M9.5 3v2.5M8.25 4.25h2.5"/>'),
  copy: icon('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>'),
  close: icon('<path d="M6 6l12 12M18 6 6 18"/>'),
  single: icon('<path d="M5 19 19 5"/>'),
  double: icon('<path d="M4 16 16 4M8 20 20 8"/>'),
  triple: icon('<path d="M3.5 14.5 14.5 3.5M6.5 17.5l11-11M9.5 20.5l11-11"/>'),
  wedge: icon('<path d="M4 20 17.5 4.5l2 2z" stroke-width="1.2"/>', true),
  hash: icon('<path d="M5.8 18.2l.4.4M8.4 14.6l1 1M11 11l1.8 1.8M13.6 7.4l2.8 2.8M16.2 3.8l3.8 3.8"/>'),
  wavy: icon('<path d="M4 20c1.5-1.5 0-3 1.5-4.5S8.5 17 10 15.5 10 12.5 11.5 11 14.5 12.5 16 11s0-3 1.5-4.5S20.5 8 20 4"/>'),
  select: icon('<path d="M3.5 8V3.5H8M11.5 3.5h2M17 3.5h3.5V8M3.5 11.5v2M3.5 17v3.5H8"/><path d="M12 12l8.5 3.3-3.7 1.5-1.5 3.7z" fill="currentColor"/>'),
  rotateLeft: icon('<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 3.5v4.2h4.2"/>'),
  rotateRight: icon('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 3.5v4.2h-4.2"/>'),
  flipH: icon('<path d="M12 3v18" stroke-dasharray="2 2.6"/><path d="M8.5 7 3.5 17h5z"/><path d="M15.5 7l5 10h-5z" fill="currentColor"/>'),
  flipV: icon('<path d="M3 12h18" stroke-dasharray="2 2.6"/><path d="M7 8.5 17 3.5v5z"/><path d="M7 15.5l10 5v-5z" fill="currentColor"/>'),
  duplicate: icon('<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M4.5 15.5v-9a2 2 0 0 1 2-2h9"/><path d="M14.5 11.5v6M11.5 14.5h6"/>'),
  more: icon('<path d="M5.5 12h.01M12 12h.01M18.5 12h.01" stroke-width="3"/>'),
  cut: icon('<circle cx="6.5" cy="17.5" r="2.7"/><circle cx="17.5" cy="17.5" r="2.7"/><path d="M8.4 15.6 17.5 4M15.6 15.6 6.5 4"/>'),
  paste: icon('<path d="M9 4.5H7a2 2 0 0 0-2 2V19a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6.5a2 2 0 0 0-2-2h-2"/><rect x="9" y="2.75" width="6" height="3.5" rx="1"/>'),
  analysis: icon('<path d="M4 20h16"/><path d="M7 20V8M11 20v-6M15 20V4.5M19 20v-3"/>'),
  molecule: icon('<path d="M12 3.5l7.4 4.25v8.5L12 20.5l-7.4-4.25v-8.5z"/><path d="M12 7.5l3.9 2.25v4.5"/>'),
  selectAll: icon('<rect x="3.5" y="3.5" width="17" height="17" rx="2" stroke-dasharray="3 2.6"/><path d="M8 12.5l2.8 2.8L16.5 9"/>'),
  deselect: icon('<rect x="3.5" y="3.5" width="17" height="17" rx="2" stroke-dasharray="3 2.6"/><path d="M9.5 9.5l5 5M14.5 9.5l-5 5"/>'),
  swap: icon('<path d="M4 8h14.5M15 4.5 18.5 8 15 11.5"/><path d="M20 16H5.5M9 12.5 5.5 16 9 19.5"/>'),
  atom: icon('<circle cx="12" cy="12" r="2.4" fill="currentColor"/><path d="M12 3.5v4M12 16.5v4M4.6 7.75l3.5 2M15.9 14.25l3.5 2M4.6 16.25l3.5-2M15.9 9.75l3.5-2"/>'),
};
