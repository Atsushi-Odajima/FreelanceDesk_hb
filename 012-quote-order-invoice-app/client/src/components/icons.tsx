const P = (d: string) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
export const IconHome = () => P('M3 11l9-8 9 8M5 10v10h14V10');
export const IconFolder = () => P('M3 6h6l2 2h10v11H3z');
export const IconYen = () => P('M6 3l6 8 6-8M12 11v10M7 13h10M7 17h10');
export const IconUsers = () => P('M16 20v-2a4 4 0 0 0-8 0v2M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 20v-2a4 4 0 0 0-3-3.9M2 20v-2a4 4 0 0 1 3-3.9');
export const IconMenu = () => P('M4 6h16M4 12h16M4 18h16');
export const IconBox = () => P('M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10');
export const IconSearch = () => P('M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3');
export const IconGear = () => P('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z');
export const IconBank = () => P('M3 10l9-6 9 6M5 10v8M9 10v8M15 10v8M19 10v8M3 20h18');
