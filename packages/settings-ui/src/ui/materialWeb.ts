// Registers the Material Web components used by the gated new settings UI.
// Import this from new-UI modules that render Material Web elements. ES modules
// dedupe registration while keeping legacy-only paths free of direct usage.
import '@material/web/elevation/elevation.js';
import '@material/web/progress/circular-progress.js';
import '@material/web/ripple/ripple.js';
import '@material/web/list/list.js';
import '@material/web/list/list-item.js';
import '@material/web/switch/switch.js';
import '@material/web/checkbox/checkbox.js';
import '@material/web/textfield/filled-text-field.js';
import '@material/web/select/filled-select.js';
import '@material/web/select/select-option.js';
import '@material/web/tabs/tabs.js';
import '@material/web/tabs/primary-tab.js';
import '@material/web/button/filled-button.js';
import '@material/web/button/outlined-button.js';
import '@material/web/button/text-button.js';
import '@material/web/iconbutton/icon-button.js';
import '@material/web/chips/assist-chip.js';

const defineMaterialSelectOptionCollection = () => {
  const selectCtor = customElements.get('md-filled-select');
  if (!selectCtor) return;
  const prototype = selectCtor.prototype as HTMLElement & {
    options?: HTMLElement[];
  };
  if (Object.getOwnPropertyDescriptor(prototype, 'options')) return;
  Object.defineProperty(prototype, 'options', {
    configurable: true,
    get(this: HTMLElement) {
      return Array.from(this.querySelectorAll<HTMLElement>('md-select-option'));
    },
  });
};

defineMaterialSelectOptionCollection();
