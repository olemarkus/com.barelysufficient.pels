const path = require('node:path');

module.exports = {
  extends: ['stylelint-config-recommended'],
  plugins: ['stylelint-value-no-unknown-custom-properties'],
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
        '/^(color|background|background-color|border|border-color|border-(top|right|bottom|left)-color|outline|outline-color|fill|stroke|box-shadow|caret-color|text-decoration-color|column-rule-color)$/': [
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
};
