'use strict';

// Thin runtime shim — the implementation lives in ./src/api.ts, compiled to
// `.homeybuild` by the root tsc build (`tsconfig.json` includes
// `widgets/*/src/api.ts`). Shared-domain helpers load once per process this
// way; the previous esbuild bundle inlined a private copy into every widget.
// See scripts/build-widgets.mjs for the full rationale.
module.exports = require('./src/api');
