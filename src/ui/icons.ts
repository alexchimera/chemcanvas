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
  copy: icon('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>'),
  close: icon('<path d="M6 6l12 12M18 6 6 18"/>'),
  single: icon('<path d="M5 19 19 5"/>'),
  double: icon('<path d="M4 16 16 4M8 20 20 8"/>'),
  triple: icon('<path d="M3.5 14.5 14.5 3.5M6.5 17.5l11-11M9.5 20.5l11-11"/>'),
  wedge: icon('<path d="M4 20 17.5 4.5l2 2z" stroke-width="1.2"/>', true),
  hash: icon('<path d="M5.8 18.2l.4.4M8.4 14.6l1 1M11 11l1.8 1.8M13.6 7.4l2.8 2.8M16.2 3.8l3.8 3.8"/>'),
  wavy: icon('<path d="M4 20c1.5-1.5 0-3 1.5-4.5S8.5 17 10 15.5 10 12.5 11.5 11 14.5 12.5 16 11s0-3 1.5-4.5S20.5 8 20 4"/>'),
};
