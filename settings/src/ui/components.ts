/**
 * Reusable UI Components
 *
 * Shared component factory functions for consistent UI across all tabs.
 */

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
    onClick?: (e: Event) => void;
};

export type CheckboxOptions = {
    title: string;
    checked: boolean;
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
        onClick,
    } = options;

    const row = document.createElement('div');
    row.className = `device-row ${className}`.trim();
    row.setAttribute('role', 'listitem');
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
    if (title) {
        bar.title = title;
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
    const { title, checked, onChange } = options;

    const label = document.createElement('label');
    label.className = 'checkbox-icon';
    label.title = title;

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', () => {
        const result = onChange(input.checked);
        if (result instanceof Promise) {
            result.catch(console.error);
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
    if (title) input.title = title;

    input.addEventListener('change', () => {
        const val = parseFloat(input.value);
        if (Number.isFinite(val)) {
            const result = onChange(val);
            if (result instanceof Promise) {
                result.catch(console.error);
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
            result.catch(console.error);
        }
    });

    return select;
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
