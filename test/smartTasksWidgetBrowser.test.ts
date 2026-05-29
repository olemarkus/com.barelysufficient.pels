import { registerHiddenGuardSuite } from './cssTestUtils';

// The renderer switches views (.list-view/.detail-view) and toggles the row
// list (.rows) plus the empty/overflow/detail lines by setting the `hidden`
// attribute, so a hidden view would stack on top of the visible one and the
// widget reads as frozen / unresponsive to taps without the blanket reset.
// See test/cssTestUtils.ts for the shared parsing + guard assertions.
registerHiddenGuardSuite({
  name: 'smart tasks widget hidden-element CSS',
  cssRelativePath: 'widgets/smart_tasks/public/index.css',
  // Every element the renderer toggles `.hidden` on (render.ts), keyed by the
  // class CSS targets it with. Each must end up `display:none` while hidden.
  hiddenToggledSelectors: [
    '.list-view', '.detail-view', // views
    '.rows', // row list (hidden when the payload is empty)
    '.empty', '.empty-hint', '.overflow', // list affordances
    '.detail-line', // toggled detail text lines
  ],
});
