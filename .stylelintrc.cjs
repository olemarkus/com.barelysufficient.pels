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
    'selector-max-specificity': '1,4,1',
    'selector-class-pattern': '^(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?:__(?:[a-z0-9]+(?:-[a-z0-9]+)*))?(?:--(?:[a-z0-9]+(?:-[a-z0-9]+)*))?$',
    'custom-property-pattern': '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$',
    'keyframes-name-pattern': '^[a-z][a-z0-9-]*$',
    'declaration-block-no-shorthand-property-overrides': true,
    'declaration-block-no-redundant-longhand-properties': true,
  },
  overrides: [
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
        'scale-unlimited/declaration-strict-value': [
          ['/color$/', 'fill', 'stroke', 'background'],
          {
            ignoreFunctions: false,
            // Allow `color-mix()` only when it mixes a token — i.e. it contains a
            // `var(...)`. A `color-mix()` over bare literals (e.g.
            // `color-mix(in srgb, #fff 20%, transparent)`) does NOT match and is
            // rejected, closing the literal-inside-color-mix bypass.
            ignoreValues: ['/color-mix\\(.*var\\(/', 'transparent', 'currentColor', 'inherit', 'initial', 'unset', 'revert', 'none'],
          },
        ],
      },
    },
  ],
};
