import type React from 'react';

export type UiIconName = 'cursor' | 'scissors' | 'undo' | 'redo' | 'snap' | 'marker' | 'plus' | 'fit' | 'previous' | 'play' | 'pause' | 'next' | 'rewind' | 'quality' | 'layout' | 'audio' | 'speed' | 'animation' | 'appearance' | 'text';

const paths: Record<UiIconName, React.ReactNode> = {
  cursor: <><path d="m5 3 10 8-5 .8-2.4 4.7z" /><path d="m10 12 4 5" /></>,
  scissors: <><circle cx="6" cy="7" r="2.2" /><circle cx="6" cy="17" r="2.2" /><path d="m8 8.5 9-5M8 15.5l9 5M10 12l7-4" /></>,
  undo: <><path d="M9 7H4v-5" /><path d="M4 7c2.1-2.2 4.7-3.2 7.5-2.8A8 8 0 1 1 5 17" /></>,
  redo: <><path d="M15 7h5v-5" /><path d="M20 7c-2.1-2.2-4.7-3.2-7.5-2.8A8 8 0 1 0 19 17" /></>,
  snap: <><path d="M7 4v7a5 5 0 0 0 10 0V4" /><path d="M7 7h4M13 7h4M5 18h14" /></>,
  marker: <><path d="M12 21s6-5.1 6-11a6 6 0 1 0-12 0c0 5.9 6 11 6 11Z" /><circle cx="12" cy="10" r="2" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  fit: <><path d="M8 4H4v4M16 4h4v4M8 20H4v-4M16 20h4v-4" /><path d="m4 8 5-5M20 8l-5-5M4 16l5 5M20 16l-5 5" /></>,
  previous: <><path d="M7 5v14M18 6l-8 6 8 6Z" /></>,
  play: <path d="m9 6 9 6-9 6Z" />,
  pause: <><path d="M9 6v12M15 6v12" /></>,
  next: <><path d="M17 5v14M6 6l8 6-8 6Z" /></>,
  rewind: <><path d="M5 5v14M19 7l-8 5 8 5Z" /></>,
  quality: <><path d="M5 7h14M7 12h10M9 17h6" /><circle cx="5" cy="7" r="1" /><circle cx="17" cy="12" r="1" /><circle cx="9" cy="17" r="1" /></>,
  layout: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M12 4v16M4 11h8" /></>,
  audio: <><path d="M5 10v4h4l5 4V6L9 10Z" /><path d="M17 9a4 4 0 0 1 0 6" /></>,
  speed: <><path d="M5 16a8 8 0 1 1 14 0" /><path d="m12 13 4-5" /><circle cx="12" cy="13" r="1.2" /></>,
  animation: <><path d="M5 12h4l2-5 3 10 2-5h3" /><path d="M4 4h16v16H4z" /></>,
  appearance: <><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 1 0 16Z" /></>,
  text: <><path d="M5 6h14M12 6v12M8 18h8" /></>,
};

export function UiIcon({ name, className }: { name: UiIconName; className?: string }) {
  return <svg className={className ? `ui-icon ${className}` : 'ui-icon'} viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}
