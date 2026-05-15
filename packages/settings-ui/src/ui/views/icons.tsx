import type { JSX } from 'preact';

// Material Symbols-style icons rendered inline as SVG so the Settings UI does
// not need to load a separate icon font. Each icon uses a 24x24 viewBox and
// inherits `currentColor`, matching the existing PELS inline icon pattern
// (see `pels-icon-managed/limit/price` in `index.html`).

type IconProps = Omit<JSX.SVGAttributes<SVGSVGElement>, 'children' | 'viewBox'>;

const baseSvgProps = (
  rest: IconProps,
): JSX.SVGAttributes<SVGSVGElement> => ({
  viewBox: '0 0 24 24',
  width: '1em',
  height: '1em',
  fill: 'currentColor',
  'aria-hidden': 'true',
  focusable: 'false',
  ...rest,
});

export const ArrowBackIcon = (props: IconProps) => (
  <svg {...baseSvgProps(props)}>
    <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
  </svg>
);

export const ChevronRightIcon = (props: IconProps) => (
  <svg {...baseSvgProps(props)}>
    <path d="m8.59 16.59 4.58-4.59-4.58-4.59L10 6l6 6-6 6-1.41-1.41z" />
  </svg>
);

// Material `expand_more` glyph. Used as the disclosure chevron on `<details>`
// summaries; the CSS rule `details[open] > summary .disclosure-chevron`
// rotates it 180deg to mirror `expand_less` when the disclosure is open.
export const ExpandMoreIcon = (props: IconProps) => (
  <svg {...baseSvgProps(props)}>
    <path d="M16.59 8.59 12 13.17 7.41 8.59 6 10l6 6 6-6-1.41-1.41z" />
  </svg>
);
