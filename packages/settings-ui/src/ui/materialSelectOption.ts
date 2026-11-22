type MaterialSelectOptionElement = HTMLElement & {
  value: string;
  selected: boolean;
  displayText: string;
  typeaheadText: string;
  disabled: boolean;
};

export const createSelectOption = (value: string, label: string, selected = false): MaterialSelectOptionElement => {
  const option = document.createElement('md-select-option') as MaterialSelectOptionElement;
  option.value = value;
  option.setAttribute('value', value);
  option.selected = selected;
  // md-select reads `firstSelectedOption.displayText` synchronously while
  // resolving its initial value. By default that getter walks the option's
  // `[slot="headline"]` assignedElements, which are only available after the
  // option's own first render — a race that leaves the closed field blank (the
  // "Device" / "Homey device" pickers showed an empty box on first paint).
  // Setting `displayText`/`typeaheadText` as properties bypasses the slot lookup
  // and guarantees a label on first paint. Mirrors `createModeOption` in modes.ts.
  option.displayText = label;
  option.typeaheadText = label;
  const headline = document.createElement('div');
  headline.slot = 'headline';
  headline.textContent = label;
  option.appendChild(headline);
  return option;
};
