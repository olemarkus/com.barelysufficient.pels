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
