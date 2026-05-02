// Registers the Material Web components used by the overview redesign.
// Imported only from planRedesign.ts so legacy bundle paths exclude them
// when tree-shaking runs, but esbuild's IIFE bundle includes them once
// the redesign flag is wired in. See docs/overview-redesign.md (TODO).
import '@material/web/elevation/elevation.js';
import '@material/web/progress/circular-progress.js';
import '@material/web/ripple/ripple.js';
