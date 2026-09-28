// ─── Icone (SVG inline, offline) ────────────────────────────────────────────
const ICONS = {
  square:            '<rect x="3" y="3" width="18" height="18" rx="2"/>',
  'square-check':    '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m9 12 2 2 4-4"/>',
  info:              '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  alert:             '<path d="M12 3 2 21h20L12 3Z"/><path d="M12 9v5"/><path d="M12 18h.01"/>',
  chevron:           '<path d="m6 9 6 6 6-6"/>',
  search:            '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>',
  x:                 '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  moon:              '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  sun:               '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  bulb:              '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5.76.76 1.23 1.52 1.41 2.5"/>',
};
function icon(name, cls = '') {
  return `<svg class="ico ${cls}" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}
