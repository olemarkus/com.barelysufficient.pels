/**
 * Reusable UI Components
 *
 * Shared component factory functions for consistent UI across all tabs.
 */

import { logSettingsError } from './logging.ts';
import { setTooltip } from './tooltips.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type DeviceRowOptions = {
    id?: string;
    name: string;
    className?: string;
    nameClassName?: string;
    controls?: HTMLElement[];
    controlsClassName?: string;
    element?: 'div' | 'li';
    listItemRole?: boolean;
    onClick?: (e: Event) => void;
};

export type CheckboxOptions = {
    title: string;
    checked: boolean;
    disabled?: boolean;
    onChange: (checked: boolean) => void | Promise<void>;
};

export type NumberInputOptions = {
    value: number;
    min?: number;
    max?: number;
    step?: number;
    className?: string;
    title?: string;
    onChange: (value: number) => void | Promise<void>;
};

export type SelectOption = {
    value: string;
    label: string;
    selected?: boolean;
};

export type SelectInputOptions = {
    options: SelectOption[];
    className?: string;
    onChange: (value: string) => void | Promise<void>;
};

export type UsageBarOptions = {
    value: number;
    max: number;
    minFillPct?: number;
    className?: string;
    fillClassName?: string;
    labelText?: string;
    labelClassName?: string;
    title?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Row Components
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a standard device row with name and optional controls.
 */
export const createDeviceRow = (options: DeviceRowOptions): HTMLElement => {
    const {
        id,
        name,
        className = '',
        nameClassName = '',
        controls = [],
        controlsClassName = 'device-row__inputs',
        element = 'li',
        listItemRole = false,
        onClick,
    } = options;

    const row = document.createElement(element);
    row.className = `device-row ${className}`.trim();
    if (listItemRole) {
        row.setAttribute('role', 'listitem');
    }
    if (id) {
        row.dataset.deviceId = id;
    }

    const nameWrap = document.createElement('div');
    nameWrap.className = ['device-row__name', nameClassName].filter(Boolean).join(' ');
    nameWrap.textContent = name;

    if (controls.length > 0) {
        const controlsWrap = document.createElement('div');
        controlsWrap.className = controlsClassName;
        controls.forEach((ctrl) => controlsWrap.appendChild(ctrl));
        row.append(nameWrap, controlsWrap);
    } else {
        row.appendChild(nameWrap);
    }

    if (onClick) {
        row.classList.add('clickable');
        row.addEventListener('click', (e) => {
            // Don't trigger row click if clicking on input elements
            if ((e.target as HTMLElement).closest('input, select, button, a')) return;
            onClick(e);
        });
    }

    return row;
};

/**
 * Creates a labeled metadata line (label: value).
 */
export const createMetaLine = (label: string, value: string): HTMLElement => {
    const line = document.createElement('div');
    line.className = 'plan-meta-line';

    const labelEl = document.createElement('span');
    labelEl.className = 'plan-label';
    labelEl.textContent = label;

    const valueEl = document.createElement('span');
    valueEl.textContent = value;

    line.append(labelEl, valueEl);
    return line;
};

// ─────────────────────────────────────────────────────────────────────────────
// Data Visual Components
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a reusable usage bar with optional label.
 */
export const createUsageBar = (options: UsageBarOptions): HTMLElement => {
    const {
        value,
        max,
        minFillPct = 4,
        className = '',
        fillClassName = '',
        labelText,
        labelClassName = '',
        title,
    } = options;

    const bar = document.createElement('div');
    bar.className = ['usage-bar', className].filter(Boolean).join(' ');
    const tooltip = title || labelText;
    if (tooltip) {
        setTooltip(bar, tooltip);
    }

    const ratio = max > 0 ? Math.min(1, value / max) : 0;
    const fill = document.createElement('div');
    fill.className = ['usage-bar__fill', fillClassName].filter(Boolean).join(' ');
    fill.style.width = `${Math.max(minFillPct, ratio * 100)}%`;

    bar.appendChild(fill);

    if (labelText) {
        const label = document.createElement('span');
        label.className = ['usage-bar__label', labelClassName].filter(Boolean).join(' ');
        label.textContent = labelText;
        bar.appendChild(label);
    }

    return bar;
};

// ─────────────────────────────────────────────────────────────────────────────
// Input Components
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a checkbox wrapped in a label with icon styling.
 */
export const createCheckboxLabel = (options: CheckboxOptions): HTMLElement => {
    const { title, checked, disabled = false, onChange } = options;

    const label = document.createElement('label');
    label.className = 'checkbox-icon';
    setTooltip(label, title);
    if (disabled) {
        label.classList.add('is-disabled');
    }

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.disabled = disabled;
    input.setAttribute('aria-label', title);
    input.addEventListener('change', () => {
        const result = onChange(input.checked);
        if (result instanceof Promise) {
            result.catch((error) => {
                void logSettingsError('Checkbox action failed', error, 'components');
            });
        }
    });

    label.appendChild(input);
    return label;
};

export type IconToggleOptions = CheckboxOptions & {
    iconTemplateId: string;
};

/**
 * Icon-based toggle: tap to switch a behaviour on/off. Renders an SVG icon
 * cloned from a <template> in the DOM, with a pill background when active.
 * Exposes WAI-ARIA `role="switch"` + `aria-checked` so screen readers
 * announce the state transition.
 */
export const createIconToggle = (options: IconToggleOptions): HTMLElement => {
    const { title, checked, disabled = false, onChange, iconTemplateId } = options;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pels-icon-toggle';
    button.setAttribute('role', 'switch');
    button.setAttribute('aria-checked', String(checked));
    button.setAttribute('aria-label', title);
    setTooltip(button, title);
    if (checked) button.classList.add('is-on');
    if (disabled) {
        // aria-disabled, not native `disabled`: native suppresses click events
        // entirely, which kills the tippy delegate that surfaces the tooltip
        // explaining why the toggle is off.
        button.classList.add('is-disabled');
        button.setAttribute('aria-disabled', 'true');
    }

    const template = document.getElementById(iconTemplateId) as HTMLTemplateElement | null;
    if (template) {
        button.appendChild(template.content.cloneNode(true));
    }

    button.addEventListener('click', () => {
        if (button.getAttribute('aria-disabled') === 'true') return;
        const next = button.getAttribute('aria-checked') !== 'true';
        button.setAttribute('aria-checked', String(next));
        button.classList.toggle('is-on', next);
        const result = onChange(next);
        if (result instanceof Promise) {
            result.catch((error) => {
                void logSettingsError('Icon toggle action failed', error, 'components');
            });
        }
    });

    return button;
};

/**
 * Creates a number input with validation.
 */
export const createNumberInput = (options: NumberInputOptions): HTMLInputElement => {
    const { value, min, max, step = 1, className = '', title = '', onChange } = options;

    const input = document.createElement('input');
    input.type = 'number';
    input.value = value.toString();
    input.step = step.toString();
    if (min !== undefined) input.min = min.toString();
    if (max !== undefined) input.max = max.toString();
    if (className) input.className = className;
    if (title) {
        setTooltip(input, title);
        input.setAttribute('aria-label', title);
    }

    input.addEventListener('change', () => {
        const val = parseFloat(input.value);
        if (Number.isFinite(val)) {
            const result = onChange(val);
            if (result instanceof Promise) {
                result.catch((error) => {
                    void logSettingsError('Number input action failed', error, 'components');
                });
            }
        }
    });

    return input;
};

/**
 * Creates a select dropdown.
 */
export const createSelectInput = (options: SelectInputOptions): HTMLSelectElement => {
    const { options: selectOptions, className = '', onChange } = options;

    const select = document.createElement('select');
    if (className) select.className = className;

    selectOptions.forEach((opt) => {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.label;
        if (opt.selected) option.selected = true;
        select.appendChild(option);
    });

    select.addEventListener('change', () => {
        const result = onChange(select.value);
        if (result instanceof Promise) {
            result.catch((error) => {
                void logSettingsError('Select input action failed', error, 'components');
            });
        }
    });

    return select;
};

// ─────────────────────────────────────────────────────────────────────────────
// Toggle Group
// ─────────────────────────────────────────────────────────────────────────────

export type ToggleOption<T extends string> = {
    value: T;
    label: string;
};

export type ToggleGroupResult<T extends string> = {
    element: HTMLElement;
    setActive: (value: T | null) => void;
};

/**
 * Creates a button-group toggle (day-view style). Returns the container element
 * and a setActive helper so callers never touch classes directly.
 */
export const createToggleGroup = <T extends string>(
    options: ToggleOption<T>[],
    ariaLabel: string,
    onSelect: (value: T) => void,
): ToggleGroupResult<T> => {
    const container = document.createElement('div');
    container.className = 'day-view-toggle';
    container.setAttribute('role', 'group');
    container.setAttribute('aria-label', ariaLabel);

    const buttons = new Map<T, HTMLButtonElement>();
    options.forEach(({ value, label }) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'day-view-toggle__button';
        btn.textContent = label;
        btn.setAttribute('aria-pressed', 'false');
        btn.addEventListener('click', () => onSelect(value));
        container.appendChild(btn);
        buttons.set(value, btn);
    });

    const setActive = (active: T | null) => {
        buttons.forEach((btn, value) => {
            const isActive = value === active;
            btn.classList.toggle('is-active', isActive);
            btn.setAttribute('aria-pressed', String(isActive));
        });
    };

    return { element: container, setActive };
};

// ─────────────────────────────────────────────────────────────────────────────
// Checkbox Field
// ─────────────────────────────────────────────────────────────────────────────

export type CheckboxFieldOptions = {
    id: string;
    label: string;
    hint?: string;
    checked?: boolean;
};

export type CheckboxFieldResult = {
    element: HTMLElement;
    input: HTMLInputElement;
};

export type FieldOptions = {
    label: string;
    control: HTMLElement;
    hint?: string;
    className?: string;
    element?: 'div' | 'label';
    id?: string;
    hidden?: boolean;
};

/**
 * Creates a labeled checkbox with optional hint text (.field.checkbox-field pattern).
 * Returns the wrapper element and the input so callers can read/set .checked directly.
 */
export const createCheckboxField = (options: CheckboxFieldOptions): CheckboxFieldResult => {
    const { id, label, hint, checked = false } = options;

    const wrapper = document.createElement('label');
    wrapper.className = 'field checkbox-field';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.checked = checked;

    const content = document.createElement('span');
    content.className = 'checkbox-field__content';

    const labelSpan = document.createElement('span');
    labelSpan.className = 'field__label';
    labelSpan.textContent = label;
    content.appendChild(labelSpan);

    if (hint) {
        const hintEl = document.createElement('small');
        hintEl.className = 'field__hint';
        hintEl.textContent = hint;
        content.appendChild(hintEl);
    }

    wrapper.appendChild(input);
    wrapper.appendChild(content);

    return { element: wrapper, input };
};

/**
 * Creates a standard labeled field wrapper with optional hint text.
 */
export const createField = (options: FieldOptions): HTMLElement => {
    const {
        label,
        control,
        hint,
        className = '',
        element = 'label',
        id,
        hidden = false,
    } = options;

    const wrapper = document.createElement(element);
    wrapper.className = ['field', className].filter(Boolean).join(' ');
    if (id) wrapper.id = id;
    wrapper.hidden = hidden;

    const labelEl = document.createElement('span');
    labelEl.className = 'field__label';
    labelEl.textContent = label;
    wrapper.appendChild(labelEl);
    wrapper.appendChild(control);

    if (hint) {
        const hintEl = document.createElement('small');
        hintEl.className = 'field__hint';
        hintEl.textContent = hint;
        wrapper.appendChild(hintEl);
    }

    return wrapper;
};

// ─────────────────────────────────────────────────────────────────────────────
// Drag Handle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a drag handle for sortable lists.
 */
export const createDragHandle = (): HTMLElement => {
    const handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.innerHTML = [
        '<svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor">',
        '<circle cx="3" cy="3" r="1.5"/><circle cx="9" cy="3" r="1.5"/>',
        '<circle cx="3" cy="8" r="1.5"/><circle cx="9" cy="8" r="1.5"/>',
        '<circle cx="3" cy="13" r="1.5"/><circle cx="9" cy="13" r="1.5"/>',
        '</svg>',
    ].join('');
    return handle;
};

// ─────────────────────────────────────────────────────────────────────────────
// List Utilities
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Segmented Control (binds to a hidden <select>)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Binds a segmented control container ([role="radiogroup"]) to a sibling
 * <select>. The select stays the source of truth: option text, value, hidden,
 * and disabled state propagate to the visible buttons. Clicking a button
 * updates the select's value and dispatches a change event so existing
 * select-change handlers still work.
 *
 * Buttons are created once and updated in place on subsequent refreshes so
 * keyboard focus survives renders. Call refresh() (or dispatch
 * `pels:segmented-refresh` on the select) after mutating option text, hidden,
 * or disabled state.
 */
export const bindSegmentedToSelect = (params: {
    container: HTMLElement;
    select: HTMLSelectElement;
}): { refresh: () => void } => {
    const { container, select } = params;
    const buttons = new Map<HTMLOptionElement, HTMLButtonElement>();

    const isInteractive = (button: HTMLButtonElement) => !button.disabled && !button.hidden;

    const visibleEnabledOptions = () => (select.disabled ? [] : Array.from(select.options).filter((option) => (
        !option.hidden && !option.disabled
    )));

    const focusOption = (option: HTMLOptionElement) => {
        const button = buttons.get(option);
        if (!button) return;
        select.value = option.value;
        render();
        button.focus();
        select.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const handleKeydown = (event: KeyboardEvent, option: HTMLOptionElement) => {
        const movableOptions = visibleEnabledOptions();
        if (movableOptions.length === 0) return;
        const currentIndex = movableOptions.indexOf(option);
        let nextIndex: number;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
            nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % movableOptions.length;
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
            nextIndex = currentIndex === -1
                ? movableOptions.length - 1
                : (currentIndex - 1 + movableOptions.length) % movableOptions.length;
        } else if (event.key === 'Home') {
            nextIndex = 0;
        } else if (event.key === 'End') {
            nextIndex = movableOptions.length - 1;
        } else {
            return;
        }
        event.preventDefault();
        const target = movableOptions[nextIndex];
        if (target && target !== option) focusOption(target);
    };

    const createButton = (option: HTMLOptionElement): HTMLButtonElement => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'segmented__option';
        button.setAttribute('role', 'radio');
        button.dataset.value = option.value;
        button.addEventListener('click', () => {
            if (!isInteractive(button)) return;
            if (select.value === option.value) return;
            select.value = option.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        button.addEventListener('keydown', (event) => handleKeydown(event, option));
        return button;
    };

    const render = () => {
        const options = Array.from(select.options);
        const seen = new Set<HTMLOptionElement>();
        container.setAttribute('aria-disabled', select.disabled ? 'true' : 'false');

        // Detect the focusable button: prefer the currently-selected visible+enabled
        // option, otherwise fall back to the first visible+enabled option so the
        // group always has exactly one tabbable target. When the select itself is
        // disabled, no button is tabbable.
        const interactive = visibleEnabledOptions();
        const selectedIfInteractive = interactive.find((option) => option.value === select.value);
        const focusableOption = selectedIfInteractive ?? interactive[0] ?? null;

        options.forEach((option, index) => {
            seen.add(option);
            let button = buttons.get(option);
            if (!button) {
                button = createButton(option);
                buttons.set(option, button);
            }
            if (button.dataset.value !== option.value) button.dataset.value = option.value;
            const label = option.textContent || option.value;
            if (button.textContent !== label) button.textContent = label;
            // Reflect the selected value even when the option is disabled (ARIA
            // permits a disabled+checked radio). Hidden options are never
            // visually selected because they're not rendered.
            const isChecked = option.value === select.value && !option.hidden;
            button.setAttribute('aria-checked', isChecked ? 'true' : 'false');
            button.disabled = option.disabled || select.disabled;
            button.hidden = option.hidden;
            button.tabIndex = option === focusableOption ? 0 : -1;

            const existing = container.children[index];
            if (existing !== button) {
                container.insertBefore(button, existing ?? null);
            }
        });

        // Remove any buttons whose options were detached from the select.
        buttons.forEach((button, option) => {
            if (seen.has(option)) return;
            button.remove();
            buttons.delete(option);
        });
    };

    render();
    select.addEventListener('change', render);
    // Also listen for a custom event that lets external code request a redraw
    // after mutating option.hidden / option.disabled / option.textContent /
    // select.value without triggering a real change event (which would re-fire
    // user handlers).
    select.addEventListener('pels:segmented-refresh', render as EventListener);
    return { refresh: render };
};

/**
 * Renders a list of items into a container, handling empty state.
 */
export const renderList = <T>(
    listContainer: HTMLElement,
    emptyEl: HTMLElement,
    items: T[],
    renderItem: (item: T) => HTMLElement,
): void => {
    listContainer.replaceChildren();
    const emptyTarget = emptyEl;

    if (items.length === 0) {
        emptyTarget.hidden = false;
        return;
    }

    emptyTarget.hidden = true;

    const fragment = document.createDocumentFragment();
    items.forEach((item) => {
        fragment.appendChild(renderItem(item));
    });
    listContainer.appendChild(fragment);
};
