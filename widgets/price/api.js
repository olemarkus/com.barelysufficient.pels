'use strict';

// Thin runtime shim — the implementation lives in ./src/api.ts, compiled to
// `.homeybuild` by the root tsc build (`tsconfig.json` includes
// `widgets/*/src/api.ts`). See scripts/build-widgets.mjs for the rationale.
module.exports = require('./src/api');
