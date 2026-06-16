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

// Material `tune` glyph. Marks the Budget page's Adjust trigger so the
// entry into the budget-settings surface reads as "settings live here".
export const TuneIcon = (props: IconProps) => (
  <svg {...baseSvgProps(props)}>
    <path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z" />
  </svg>
);

// Material `warning` glyph. Used by the dry-run, stale-data, and budget
// allocation banner primitives in place of the U+26A0 Unicode emoji so the
// icon stays consistent across Apple, Google, and Microsoft glyph sets.
export const WarningIcon = (props: IconProps) => (
  <svg {...baseSvgProps(props)}>
    <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
  </svg>
);

// Material `bolt` glyph. Leads the Overview "Exempt from budget" action chip:
// the lightning bolt reads as "let it run / give it power now", the consequence
// of exempting the device from today's budget. It also visually separates the
// tappable action chip from the adjacent "Budget limited" status badge (which
// has no icon).
export const BoltIcon = (props: IconProps) => (
  <svg {...baseSvgProps(props)}>
    <path d="M7 2v11h3v9l7-12h-4l4-8z" />
  </svg>
);
