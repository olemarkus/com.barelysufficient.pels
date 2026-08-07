/**
 * Single source of truth for node_modules entries pruned from the packaged
 * app. Consumed by scripts/sanitize-homey-build.mjs (which deletes them from
 * .homeybuild) AND scripts/check-homeybuild-requires.mjs (which fails any
 * shipped runtime require() that would resolve into them) — keeping the two
 * from drifting is the whole point of this module.
 */
export const prunedNodeModules = [
  '.bin',
  '@pels',
  '@napi-rs',
  '@lit',
  '@lit-labs',
  '@material',
  'lit',
  'lit-element',
  'lit-html',
  // Bundler-only, like @material/lit above: packages/settings-ui declares it as
  // a runtime dependency so Homey's production install pulls it in, but esbuild
  // inlines preact into settings/script.js and the widget bundles. Nothing in
  // the packaged app resolves it from node_modules — it was 2.0 MB of ballast.
  'preact',
];
