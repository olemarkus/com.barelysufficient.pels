import { bindSegmentedToSelect } from '../src/ui/components.ts';

const setupDom = () => {
  document.body.replaceChildren();
  const container = document.createElement('div');
  container.id = 'segmented';
  container.setAttribute('role', 'radiogroup');
  const select = document.createElement('select');
  select.id = 'hidden-select';
  select.hidden = true;
  (['a:Alpha', 'b:Bravo', 'c:Charlie'] as const).forEach((pair) => {
    const [value, label] = pair.split(':');
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  });
  document.body.append(container, select);
  return { container, select };
};

describe('bindSegmentedToSelect', () => {
  it('renders one button per option and marks the current value checked', () => {
    const { container, select } = setupDom();
    select.value = 'b';

    bindSegmentedToSelect({ container, select });

    const buttons = container.querySelectorAll<HTMLButtonElement>('button.segmented__option');
    expect(buttons).toHaveLength(3);
    expect(Array.from(buttons).map((b) => b.dataset.value)).toEqual(['a', 'b', 'c']);
    expect(buttons[0].getAttribute('aria-checked')).toBe('false');
    expect(buttons[1].getAttribute('aria-checked')).toBe('true');
    expect(buttons[1].tabIndex).toBe(0);
    expect(buttons[0].tabIndex).toBe(-1);
  });

  it('updates select.value and fires change when an option is clicked', () => {
    const { container, select } = setupDom();
    select.value = 'a';
    const onChange = vi.fn();
    select.addEventListener('change', onChange);

    bindSegmentedToSelect({ container, select });

    const charlieBtn = container.querySelector<HTMLButtonElement>('button[data-value="c"]')!;
    charlieBtn.click();

    expect(select.value).toBe('c');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[aria-checked="true"]')?.getAttribute('data-value')).toBe('c');
  });

  it('reflects hidden and disabled option attributes after pels:segmented-refresh', () => {
    const { container, select } = setupDom();
    bindSegmentedToSelect({ container, select });

    select.options[1].hidden = true;
    select.options[2].disabled = true;
    select.dispatchEvent(new Event('pels:segmented-refresh'));

    const buttons = container.querySelectorAll<HTMLButtonElement>('button.segmented__option');
    expect(buttons[1].hidden).toBe(true);
    expect(buttons[2].disabled).toBe(true);
  });

  it('does nothing when clicking the already-selected option', () => {
    const { container, select } = setupDom();
    select.value = 'a';
    const onChange = vi.fn();
    select.addEventListener('change', onChange);

    bindSegmentedToSelect({ container, select });
    container.querySelector<HTMLButtonElement>('button[data-value="a"]')!.click();

    expect(onChange).not.toHaveBeenCalled();
  });

  it('ignores clicks on hidden or disabled buttons', () => {
    const { container, select } = setupDom();
    select.options[1].disabled = true;
    select.options[2].hidden = true;

    bindSegmentedToSelect({ container, select });

    const buttons = container.querySelectorAll<HTMLButtonElement>('button.segmented__option');
    buttons[1].click();
    buttons[2].click();

    expect(select.value).toBe('a');
  });

  it('reuses button nodes across refreshes so focus survives', () => {
    const { container, select } = setupDom();
    bindSegmentedToSelect({ container, select });

    const firstRender = Array.from(container.querySelectorAll<HTMLButtonElement>('button.segmented__option'));
    firstRender[0].focus();
    expect(document.activeElement).toBe(firstRender[0]);

    select.dispatchEvent(new Event('pels:segmented-refresh'));

    const secondRender = Array.from(container.querySelectorAll<HTMLButtonElement>('button.segmented__option'));
    expect(secondRender[0]).toBe(firstRender[0]);
    expect(document.activeElement).toBe(firstRender[0]);
  });

  it('resets hidden and disabled when the option flips back on', () => {
    const { container, select } = setupDom();
    select.options[1].disabled = true;
    select.options[2].hidden = true;
    bindSegmentedToSelect({ container, select });

    const before = container.querySelectorAll<HTMLButtonElement>('button.segmented__option');
    expect(before[1].disabled).toBe(true);
    expect(before[2].hidden).toBe(true);

    select.options[1].disabled = false;
    select.options[2].hidden = false;
    select.dispatchEvent(new Event('pels:segmented-refresh'));

    const after = container.querySelectorAll<HTMLButtonElement>('button.segmented__option');
    expect(after[1].disabled).toBe(false);
    expect(after[2].hidden).toBe(false);
  });

  it('reflects option textContent updates on refresh', () => {
    const { container, select } = setupDom();
    bindSegmentedToSelect({ container, select });

    select.options[2].textContent = 'Charlie (updated)';
    select.dispatchEvent(new Event('pels:segmented-refresh'));

    const charlieBtn = container.querySelector<HTMLButtonElement>('button[data-value="c"]')!;
    expect(charlieBtn.textContent).toBe('Charlie (updated)');
  });

  it('moves selection on ArrowRight / ArrowLeft and skips disabled/hidden options', () => {
    const { container, select } = setupDom();
    select.value = 'a';
    bindSegmentedToSelect({ container, select });

    const buttonOf = (value: string) => container.querySelector<HTMLButtonElement>(`button[data-value="${value}"]`)!;
    buttonOf('a').focus();
    buttonOf('a').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(select.value).toBe('b');
    expect(document.activeElement).toBe(buttonOf('b'));

    select.options[2].disabled = true;
    select.dispatchEvent(new Event('pels:segmented-refresh'));
    buttonOf('b').focus();
    buttonOf('b').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(select.value).toBe('a');

    buttonOf('a').focus();
    buttonOf('a').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(select.value).toBe('b');
  });

  it('keeps the selected option visually checked even when it is disabled', () => {
    const { container, select } = setupDom();
    select.value = 'a';
    bindSegmentedToSelect({ container, select });

    select.options[0].disabled = true;
    select.dispatchEvent(new Event('pels:segmented-refresh'));

    const aBtn = container.querySelector<HTMLButtonElement>('button[data-value="a"]')!;
    expect(aBtn.getAttribute('aria-checked')).toBe('true');
    expect(aBtn.disabled).toBe(true);
    // Roving tabindex moves to the first interactive option so Tab still works.
    expect(aBtn.tabIndex).toBe(-1);
    const bBtn = container.querySelector<HTMLButtonElement>('button[data-value="b"]')!;
    expect(bBtn.tabIndex).toBe(0);
  });

  it('disables every button and clears the tab stop when the select itself is disabled', () => {
    const { container, select } = setupDom();
    select.value = 'b';
    bindSegmentedToSelect({ container, select });

    select.disabled = true;
    select.dispatchEvent(new Event('pels:segmented-refresh'));

    const buttons = container.querySelectorAll<HTMLButtonElement>('button.segmented__option');
    buttons.forEach((btn) => expect(btn.disabled).toBe(true));
    const tabbable = container.querySelectorAll('button.segmented__option[tabindex="0"]');
    expect(tabbable.length).toBe(0);
    expect(container.getAttribute('aria-disabled')).toBe('true');
    // Selected value is still reflected so the user can see the locked choice.
    expect(container.querySelector('button[data-value="b"]')?.getAttribute('aria-checked')).toBe('true');
  });

  it('keeps a tabbable button when the selected option becomes hidden', () => {
    const { container, select } = setupDom();
    select.value = 'b';
    bindSegmentedToSelect({ container, select });

    select.options[1].hidden = true;
    select.dispatchEvent(new Event('pels:segmented-refresh'));

    const tabbable = container.querySelectorAll<HTMLButtonElement>('button.segmented__option[tabindex="0"]:not([hidden])');
    expect(tabbable.length).toBe(1);
    expect(tabbable[0].dataset.value).toBe('a');
  });
});
