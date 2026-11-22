import type { Palette } from './kit';

/**
 * Palettes: the two built-in themes as they are (pure), plus inline brand
 * tokens on top of them (manifest `theme: { base, tokens }`), which is how an
 * agent gives a client its own look without creating a theme first.
 *
 * Every inline palette follows the unslop rules (Damir Sokolovsky, CC BY 4.0;
 * docs/GALLERY.md): a neutral ramp tinted toward the brand's world, one
 * accent, a desaturated secondary (accent2) for a rare second series and a
 * neutral step (accent3). No purple-to-blue defaults, headings at 600.
 */
export const PALETTES: Record<string, Palette> = {
  default: {
    id: 'default',
    name: 'Default (built-in)',
    base: 'default',
    pure: true,
    colors: { background: '#0b0b14', surface: '#1a1a2b', text: '#ffffff', mutedText: '#c9c9d6', accent: '#ff3d71', accent2: '#00d1b2' },
    accent3: '#3a3a52',
  },
  midnight: {
    id: 'midnight',
    name: 'Midnight (built-in)',
    base: 'midnight',
    pure: true,
    colors: { background: '#070b24', surface: '#141b45', text: '#f4f6ff', mutedText: '#aab3e0', accent: '#7c9cff', accent2: '#2ee6c5' },
    accent3: '#2a3366',
  },
  ember: {
    id: 'ember',
    name: 'Kiln',
    base: 'default',
    colors: { background: '#16110e', surface: '#231b17', text: '#f5efe9', mutedText: '#b5a89c', accent: '#ff7a3d', accent2: '#8c7f74' },
    accent3: '#5a4f47',
    headingWeight: 600,
  },
  mint: {
    id: 'mint',
    name: 'Fern',
    base: 'midnight',
    colors: { background: '#0f1412', surface: '#18201c', text: '#eef4f0', mutedText: '#a3b2aa', accent: '#3ddc97', accent2: '#7f8f87' },
    accent3: '#4c5a53',
    headingWeight: 600,
  },
  paper: {
    id: 'paper',
    name: 'Paper',
    base: 'default',
    light: true,
    colors: { background: '#f4f1ea', surface: '#fbf9f4', text: '#1c1915', mutedText: '#6b645a', accent: '#c8401b', accent2: '#8a8378' },
    accent3: '#d6cfc3',
    headingWeight: 600,
  },
  ocean: {
    id: 'ocean',
    name: 'Harbor',
    base: 'midnight',
    colors: { background: '#0e1418', surface: '#172027', text: '#edf3f6', mutedText: '#9fb0ba', accent: '#2fb8d6', accent2: '#7d8f99' },
    accent3: '#44545e',
    headingWeight: 600,
  },
  grape: {
    id: 'grape',
    name: 'Plum',
    base: 'default',
    colors: { background: '#151014', surface: '#211a20', text: '#f5eef3', mutedText: '#b4a5af', accent: '#e85d8a', accent2: '#8f7f8a' },
    accent3: '#574953',
    headingWeight: 600,
  },
  volt: {
    id: 'volt',
    name: 'Volt',
    base: 'default',
    colors: { background: '#111310', surface: '#1b1e19', text: '#f3f6ee', mutedText: '#a9b0a1', accent: '#c8f03c', accent2: '#858c7e' },
    accent3: '#4d5347',
    headingWeight: 600,
  },
  sunset: {
    id: 'sunset',
    name: 'Clay',
    base: 'default',
    colors: { background: '#171211', surface: '#231c1a', text: '#f7efeb', mutedText: '#b9aaa4', accent: '#f2765a', accent2: '#8f817b' },
    accent3: '#5b4e49',
    headingWeight: 600,
  },
  cream: {
    id: 'cream',
    name: 'Cream',
    base: 'midnight',
    light: true,
    colors: { background: '#f7f3ec', surface: '#fffdf9', text: '#1e1b17', mutedText: '#625c52', accent: '#1f7a5a', accent2: '#8b8579' },
    accent3: '#d8d1c5',
    headingWeight: 600,
  },
  mono: {
    id: 'mono',
    name: 'Mono',
    base: 'default',
    colors: { background: '#121212', surface: '#1d1d1d', text: '#f2f2f2', mutedText: '#a3a3a3', accent: '#f2f2f2', accent2: '#6e6e6e' },
    accent3: '#3a3a3a',
    headingWeight: 600,
  },
  rose: {
    id: 'rose',
    name: 'Rose',
    base: 'default',
    light: true,
    colors: { background: '#f8f1f0', surface: '#fffaf9', text: '#2a1a1c', mutedText: '#74605f', accent: '#c8323f', accent2: '#9a8785' },
    accent3: '#ddcfcd',
    headingWeight: 600,
  },
  forest: {
    id: 'forest',
    name: 'Forest',
    base: 'midnight',
    colors: { background: '#101410', surface: '#1a201a', text: '#eef3ec', mutedText: '#a4b0a1', accent: '#8fd16a', accent2: '#7f8a7c' },
    accent3: '#4a5447',
    headingWeight: 600,
  },
  electric: {
    id: 'electric',
    name: 'Signal',
    base: 'midnight',
    colors: { background: '#0f1216', surface: '#181d23', text: '#eef2f6', mutedText: '#9ba6b2', accent: '#4f8cff', accent2: '#7c8794' },
    accent3: '#3f4853',
    headingWeight: 600,
  },
  sand: {
    id: 'sand',
    name: 'Sand',
    base: 'default',
    light: true,
    colors: { background: '#efe8dc', surface: '#f8f3ea', text: '#2a2119', mutedText: '#6e6153', accent: '#b4471b', accent2: '#8c8172' },
    accent3: '#d3c8b7',
    headingWeight: 600,
  },
  cobalt: {
    id: 'cobalt',
    name: 'Ink',
    base: 'midnight',
    colors: { background: '#10141c', surface: '#19202b', text: '#f1f4f8', mutedText: '#a0aaba', accent: '#ffc93c', accent2: '#808a99' },
    accent3: '#414b5a',
    headingWeight: 600,
  },
};

export type PaletteId = keyof typeof PALETTES;
