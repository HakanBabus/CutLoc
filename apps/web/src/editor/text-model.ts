import type { Clip } from '@cutloc/shared';
import type { TranslationKey } from '../i18n';

export const TEXT_FONT_OPTIONS = [
  'Segoe UI, Arial, sans-serif',
  'Arial, sans-serif',
  'Inter, Arial, sans-serif',
  'Roboto, Arial, sans-serif',
  'Open Sans, Arial, sans-serif',
  'Lato, Arial, sans-serif',
  'Nunito, Arial, sans-serif',
  'DM Sans, Arial, sans-serif',
  'Montserrat, Arial, sans-serif',
  'Poppins, Arial, sans-serif',
  'Trebuchet MS, sans-serif',
  'Verdana, sans-serif',
  'Georgia, serif',
  'Playfair Display, Georgia, serif',
  'Space Grotesk, Arial, sans-serif',
  'Oswald, Arial, sans-serif',
  'Courier New, monospace',
  'Bebas Neue, Impact, sans-serif',
];

export type TextPreset = {
  id: string;
  label: string;
  category: 'title' | 'social' | 'card' | 'accent';
  description: string;
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fontStyle: 'normal' | 'italic';
  color: string;
  background: string;
  stroke: string;
  strokeWidth: number;
  shadow: boolean;
  align: 'left' | 'center' | 'right';
  letterSpacing?: number;
};

/** Readable, offline-safe text presets. They deliberately use common system
 * fonts so preview and FFmpeg export render the same way without a download. */
export const TEXT_PRESETS: TextPreset[] = [
  { id: 'clean-title', label: 'Clean title', category: 'title', description: 'Clear opener for videos', text: 'New title', fontFamily: 'Segoe UI, Arial, sans-serif', fontSize: 72, fontWeight: 750, fontStyle: 'normal', color: '#ffffff', background: 'transparent', stroke: 'transparent', strokeWidth: 0, shadow: true, align: 'center' },
  { id: 'editorial', label: 'Editorial', category: 'title', description: 'Elegant and readable serif', text: 'A story begins', fontFamily: 'Georgia, serif', fontSize: 62, fontWeight: 700, fontStyle: 'normal', color: '#fff8e8', background: 'transparent', stroke: 'transparent', strokeWidth: 0, shadow: true, align: 'center', letterSpacing: 1 },
  { id: 'social-hook', label: 'Social hook', category: 'social', description: 'Short, bold, high contrast', text: 'You need to see this!', fontFamily: 'Arial, sans-serif', fontSize: 58, fontWeight: 800, fontStyle: 'normal', color: '#ffffff', background: '#243dff', stroke: 'transparent', strokeWidth: 0, shadow: true, align: 'center' },
  { id: 'lower-third', label: 'Lower third', category: 'social', description: 'Name and location', text: 'Hakan · CutLoc', fontFamily: 'DM Sans, Arial, sans-serif', fontSize: 34, fontWeight: 600, fontStyle: 'normal', color: '#ffffff', background: '#101116dd', stroke: 'transparent', strokeWidth: 0, shadow: false, align: 'left' },
  { id: 'quote', label: 'Quote', category: 'card', description: 'Calm and emotional', text: 'Capture a moment.', fontFamily: 'Georgia, serif', fontSize: 52, fontWeight: 600, fontStyle: 'italic', color: '#ffffff', background: '#101116bb', stroke: 'transparent', strokeWidth: 0, shadow: true, align: 'center' },
  { id: 'info-card', label: 'Info card', category: 'card', description: 'Tips and explanations', text: 'Tip · Try the timeline', fontFamily: 'Segoe UI, Arial, sans-serif', fontSize: 32, fontWeight: 600, fontStyle: 'normal', color: '#102018', background: '#b7f36a', stroke: 'transparent', strokeWidth: 0, shadow: false, align: 'left' },
  { id: 'outline', label: 'Outline', category: 'accent', description: 'Bold accent over footage', text: 'Stand out', fontFamily: 'Arial, sans-serif', fontSize: 68, fontWeight: 800, fontStyle: 'normal', color: '#ffffff', background: 'transparent', stroke: '#101116', strokeWidth: 2, shadow: true, align: 'center' },
  { id: 'soft-note', label: 'Soft note', category: 'accent', description: 'Minimal and warm', text: 'A small note', fontFamily: 'Nunito, Arial, sans-serif', fontSize: 42, fontWeight: 600, fontStyle: 'normal', color: '#fff2d6', background: '#4d304acc', stroke: 'transparent', strokeWidth: 0, shadow: true, align: 'center' },
];

export function localizeTextPreset(preset: TextPreset, t: (key: TranslationKey) => string): TextPreset {
  const prefix = `preset.text.${preset.id}`;
  return { ...preset, label: t(`${prefix}.label` as TranslationKey), description: t(`${prefix}.description` as TranslationKey), text: t(`${prefix}.text` as TranslationKey) };
}

export type ShapePreset = {
  id: string;
  label: string;
  glyph: string;
  color: string;
  category: 'basic' | 'arrows' | 'symbols' | 'badges';
  description: string;
};

/**
 * Shapes intentionally remain text-based clips for now. That keeps insertion,
 * transform, keyframes and FFmpeg export on the existing stable Clip contract
 * while giving the left library a real, browsable catalog.
 */
export const SHAPE_PRESETS: ShapePreset[] = [
  { id: 'circle', label: 'Circle', glyph: '●', color: '#b7f36a', category: 'basic', description: 'Soft accent' },
  { id: 'square', label: 'Square', glyph: '■', color: '#ffd36a', category: 'basic', description: 'Sharp block' },
  { id: 'diamond', label: 'Diamond', glyph: '◆', color: '#f18df0', category: 'basic', description: 'Rotated accent' },
  { id: 'triangle', label: 'Triangle', glyph: '▲', color: '#9ce8ff', category: 'basic', description: 'Directional surface' },
  { id: 'star', label: 'Star', glyph: '★', color: '#ffd36a', category: 'symbols', description: 'Bright accent' },
  { id: 'spark', label: 'Spark', glyph: '✦', color: '#f18df0', category: 'symbols', description: 'Small shimmer' },
  { id: 'heart', label: 'Heart', glyph: '♥', color: '#ff7f9f', category: 'symbols', description: 'Emotional accent' },
  { id: 'sun', label: 'Sun', glyph: '☀', color: '#ffd36a', category: 'symbols', description: 'Warm energy' },
  { id: 'arrow-right', label: 'Right arrow', glyph: '→', color: '#9ce8ff', category: 'arrows', description: 'Point the way' },
  { id: 'arrow-up', label: 'Up arrow', glyph: '↑', color: '#9ce8ff', category: 'arrows', description: 'Move upward' },
  { id: 'arrow-diagonal', label: 'Diagonal arrow', glyph: '↗', color: '#9ce8ff', category: 'arrows', description: 'Motion direction' },
  { id: 'chevron', label: 'Chevron', glyph: '›', color: '#b7f36a', category: 'arrows', description: 'Forward callout' },
  { id: 'check', label: 'Check', glyph: '✓', color: '#82e6b5', category: 'badges', description: 'Completed' },
  { id: 'plus', label: 'Plus', glyph: '＋', color: '#b7f36a', category: 'badges', description: 'Add symbol' },
  { id: 'cross', label: 'Cross', glyph: '×', color: '#ff9d9d', category: 'badges', description: 'Close symbol' },
  { id: 'badge', label: 'Badge', glyph: '⬡', color: '#f18df0', category: 'badges', description: 'Hexagonal label' },
  { id: 'orbit', label: 'Orbit', glyph: '◒', color: '#9ce8ff', category: 'symbols', description: 'Circular motion' },
  { id: 'cloud', label: 'Cloud', glyph: '☁', color: '#d5e7ff', category: 'symbols', description: 'Light atmosphere' },
];

export function localizeShapePreset(preset: ShapePreset, t: (key: TranslationKey) => string): ShapePreset {
  const prefix = `preset.shape.${preset.id}`;
  return { ...preset, label: t(`${prefix}.label` as TranslationKey), description: t(`${prefix}.description` as TranslationKey) };
}

export const DEFAULT_TEXT_STYLE: NonNullable<Clip['textStyle']> = {
  text: 'New text',
  fontFamily: 'Inter, Arial, sans-serif',
  fontSize: 64,
  fontWeight: 700,
  fontStyle: 'normal',
  textDecoration: 'none',
  letterSpacing: 0,
  lineHeight: 1.2,
  padding: 4,
  color: '#ffffff',
  background: 'transparent',
  stroke: 'transparent',
  strokeWidth: 0,
  shadow: true,
  align: 'center',
};
