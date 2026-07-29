const path = require('node:path');

module.exports = {
  extends: ['stylelint-config-recommended'],
  plugins: [
    'stylelint-value-no-unknown-custom-properties',
    'stylelint-declaration-strict-value',
  ],
  rules: {
    // Every `var(--x)` must reference a custom property that is actually defined.
    // Token definitions are read from the committed `settings/tokens.css` — the
    // exact Style Dictionary output the app ships (built from `tokens/*.json` and
    // synced on every build). Resolved via `__dirname` so the path is stable no
    // matter the CWD (root `lint:css`, lint-staged, or an IDE running from a
    // subdir), and needs no build step before linting. Inline aliases/light-theme
    // vars are picked up from the linted files themselves.
    'csstools/value-no-unknown-custom-properties': [true, {
      importFrom: [path.resolve(__dirname, 'settings/tokens.css')],
    }],
    // Components must consume the semantic colour tier, not the base primitives.
    // Ban `var(--color-base-*)` and `var(--color-surface-*)` inside real colour
    // properties (the token-tier mapping that *defines* the semantic vars from
    // base lives on custom-property declarations like `--pels-*:` / `--md-*:`,
    // whose property names don't match this list, so it stays exempt). The
    // white/black literals are allowed — they are tint primitives used in
    // `color-mix()` with no semantic role, like a number.
    'declaration-property-value-disallowed-list': [
      {
        '/^(color|background|background-color|background-image|border(-(top|right|bottom|left|block|inline|block-start|block-end|inline-start|inline-end))?(-color)?|outline|outline-color|fill|stroke|box-shadow|caret-color|text-decoration|text-decoration-color|text-emphasis-color|column-rule|column-rule-color)$/': [
          '/var\\(\\s*--color-base-(?!white|black)/',
          '/var\\(\\s*--color-surface-/',
        ],
      },
      { message: 'Use a semantic colour token (--color-role-*, --color-state-*, --pels-*), not a --color-base-*/--color-surface-* primitive.' },
    ],
    'selector-max-specificity': '1,4,1',
    'selector-class-pattern': '^(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?:__(?:[a-z0-9]+(?:-[a-z0-9]+)*))?(?:--(?:[a-z0-9]+(?:-[a-z0-9]+)*))?$',
    'custom-property-pattern': '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$',
    'keyframes-name-pattern': '^[a-z][a-z0-9-]*$',
    'declaration-block-no-shorthand-property-overrides': true,
    'declaration-block-no-redundant-longhand-properties': true,
  },
  overrides: [
    {
      // Settings-UI colours must come from design tokens, never bare literals — the
      // dark/light themes only flip correctly through the `--color-*`/`--pels-*` vars.
      // Mirrors the widgets rule below. `ignoreFunctions: false` stops bare colour
      // functions (`rgb()`/`hsl()`/raw-literal gradients) slipping through; the
      // `/var\(/` allowance lets any value that *references a token* pass, including
      // tokenised `linear-gradient(var(--accent), …)` and `color-mix(…, var(--x))`,
      // while a function over bare literals (no `var(`) is still rejected. Lands at
      // error severity — the component CSS is already token-driven, so there is no
      // backlog to defer.
      files: ['packages/settings-ui/public/**/*.css'],
      rules: {
        'declaration-property-value-disallowed-list': [
          {
            '/^(color|background|background-color|background-image|border(-(top|right|bottom|left|block|inline|block-start|block-end|inline-start|inline-end))?(-color)?|outline|outline-color|fill|stroke|box-shadow|caret-color|text-decoration|text-decoration-color|text-emphasis-color|column-rule|column-rule-color)$/': [
              '/var\\(\\s*--color-base-(?!white|black)/',
              '/var\\(\\s*--color-surface-/',
            ],
            '/^(gap|padding|margin|margin-(top|right|bottom|left|block|inline|block-start|block-end|inline-start|inline-end))$/': [
              '/^(?:4|8|12|16|24|32)px$/',
            ],
            'border-radius': [
              '/\\b(?:8|999)px\\b/',
            ],
            'font-size': [
              '/^[0-9][0-9.]*(?:px|rem)$/',
            ],
            'animation': [
              '/^[\\w-]*pulse\\s+1\\.[456]s\\b/',
            ],
          },
          { message: 'Use the matching Settings UI design token instead of a bindable literal or primitive colour token.' },
        ],
        'scale-unlimited/declaration-strict-value': [
          ['/color$/', 'fill', 'stroke', 'background'],
          {
            ignoreFunctions: false,
            ignoreValues: ['/var\\(/', 'transparent', 'currentColor', 'inherit', 'initial', 'unset', 'revert', 'none'],
          },
        ],
      },
    },
    {
      // Dashboard widgets must take colours from Homey's `--homey-*` design tokens
      // (which adapt to the dashboard's light/dark theme) via `var()`, never a bare
      // literal. A bare `#hex`/`rgb()`/`hsl()` doesn't adapt and diverges from the
      // semantic palette. `var(--homey-x, #fallback)` is compliant — the fallback is
      // allowed (and the csstools rule above already requires a fallback for the
      // external `--homey-*` vars); `color-mix()` (tonal fills) is allow-listed via
      // `ignoreValues`. `ignoreFunctions: false` stops bare colour functions
      // (`rgb()`/`hsl()`) from slipping through.
      //
      // Limitation: `border`/`outline` shorthands aren't linted — the plugin would
      // flag their width/style tokens (`1px`, `solid`), not just the colour. Use the
      // longhand `border-color`/`outline-color` (matched by `/color$/`) when setting
      // a widget border/outline colour so it lands on a linted property.
      files: ['widgets/**/*.css'],
      rules: {
        // One rule, two jobs — colours AND every font/text property must resolve
        // to a token, never a raw value.
        //
        // Colours (`/color$/`, fill, stroke, background) take a Homey-derived
        // token; a bare `#hex`/`rgb()` doesn't adapt to the dashboard theme.
        //
        // Fonts: every text property resolves to the shared `--pw-*` semantic
        // layer (itself composed only from Homey base tokens) — never a raw
        // value. Bans raw `font-size` / `font-weight` / `line-height` /
        // `letter-spacing` / `text-transform` / `font-variant*`. A `var(...)`
        // reference passes (the `--pw-*` tokens, or `var(--pw-numeric)` for
        // tabular figures); `inherit` passes for the `font: inherit` longhands.
        // Homey ships no base token for `letter-spacing` / `text-transform`, so
        // those are simply absent from widget CSS — the guard makes that
        // structural, not a review-discipline matter. `--pw-numeric` is the one
        // documented escape hatch (see widgets/_shared/widget-tokens.css).
        //
        // `ignoreFunctions: false` + `/var\(/` in `ignoreValues`: any value that
        // references a token passes (incl. tonal `color-mix(…, var(--x))`), while
        // a bare `color-mix()` with no `var(` is still rejected — the
        // literal-inside-mix bypass stays closed.
        'scale-unlimited/declaration-strict-value': [
          ['/color$/', 'fill', 'stroke', 'background', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-transform', '/^font-variant/'],
          {
            ignoreFunctions: false,
            ignoreValues: ['/var\\(/', 'transparent', 'currentColor', 'inherit', 'initial', 'unset', 'revert', 'none'],
          },
        ],
      },
    },
  ],
};
