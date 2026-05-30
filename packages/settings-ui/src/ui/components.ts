/**
 * Reusable UI Components
 *
 * Shared component factory functions for consistent UI across all tabs.
 */

import { logSettingsError } from './logging.ts';
import { setTooltip } from './tooltips.ts';

export { bindSegmentedToSelect, type MaterialSegmentedSelectElement } from './segmentedControl.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────


export type CheckboxOptions = {
    title: string;
    checked: boolean;
    disabled?: boolean;
    onChange: (checked: boolean) => void | Promise<void>;
};






export type MaterialSwitchElement = HTMLElement & {
    selected: boolean;
    disabled: boolean;
};



export type MaterialSelectOptionElement = HTMLElement & {
    value: string;
    selected: boolean;
    disabled: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Row Components
// ─────────────────────────────────────────────────────────────────────────────



// ─────────────────────────────────────────────────────────────────────────────
// Data Visual Components
// ─────────────────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────────────────
// Input Components
// ─────────────────────────────────────────────────────────────────────────────


export type IconToggleOptions = CheckboxOptions & {
    iconTemplateId: string;
};

/**
 * Icon-based toggle: tap to switch a behaviour on/off. Renders an SVG icon
 * cloned from a <template> in the DOM, with a pill background when active.
 */
export const createIconToggle = (options: IconToggleOptions): HTMLElement => {
    const { title, checked, disabled = false, onChange, iconTemplateId } = options;

    const button = document.createElement('md-icon-button') as HTMLElement & { selected?: boolean };
    button.className = 'pels-icon-toggle';
    button.setAttribute('toggle', '');
    button.setAttribute('role', 'switch');
    button.setAttribute('aria-checked', String(checked));
    button.setAttribute('aria-label', title);
    button.selected = checked;
    button.toggleAttribute('selected', checked);
    setTooltip(button, title);
    if (checked) button.classList.add('is-on');
    if (disabled) {
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
        button.selected = next;
        button.toggleAttribute('selected', next);
        const result = onChange(next);
        if (result instanceof Promise) {
            result.catch((error) => {
                void logSettingsError('Icon toggle action failed', error, 'components');
            });
        }
    });

    return button;
};



// ─────────────────────────────────────────────────────────────────────────────
// Toggle Group (M3 segmented buttons)
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
 * Creates a view-filter toggle rendered as a canonical `.segmented` group
 * (M3 outlined segmented buttons). Returns the container and a `setActive`
 * helper so callers never touch classes directly.
 *
 * Material Web does not (yet) ship a segmented-button component; this is the
 * single bespoke primitive used everywhere a small-set, mutually-exclusive
 * filter is needed (day toggles, Plan/Adjust, Progress/Hourly plan, 7d/14d,
 * All/Weekday/Weekend, Current/History plan, device-detail When-limiting).
 * Top navigation stays on `md-tabs`.
 */
export const createToggleGroup = <T extends string>(
    options: ToggleOption<T>[],
    ariaLabel: string,
    onSelect: (value: T) => void,
): ToggleGroupResult<T> => {
    const container = document.createElement('div');
    container.className = 'segmented';
    container.setAttribute('role', 'group');
    container.setAttribute('aria-label', ariaLabel);

    const buttons = new Map<T, HTMLButtonElement>();
    options.forEach(({ value, label }) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'segmented__option hy-nostyle';
        btn.textContent = label;
        btn.setAttribute('aria-pressed', 'false');
        btn.addEventListener('click', () => onSelect(value));
        container.appendChild(btn);
        buttons.set(value, btn);
    });

    const setActive = (active: T | null) => {
        buttons.forEach((btn, value) => {
            btn.setAttribute('aria-pressed', String(value === active));
        });
    };

    return { element: container, setActive };
};

// ─────────────────────────────────────────────────────────────────────────────
// Switch Field
// ─────────────────────────────────────────────────────────────────────────────

export type SwitchFieldOptions = {
    id: string;
    label: string;
    hint?: string;
    selected?: boolean;
};

export type SwitchFieldResult = {
    element: HTMLElement;
    input: MaterialSwitchElement;
};


/**
 * Creates a labeled M3 switch with optional hint text (.md-switch-row pattern).
 * Use for binary on/off settings (M3 reserves checkboxes for selection).
 */
export const createSwitchField = (options: SwitchFieldOptions): SwitchFieldResult => {
    const { id, label, hint, selected = false } = options;

    const wrapper = document.createElement('div');
    wrapper.className = 'md-switch-row';

    const labelId = `${id}-label`;
    const input = document.createElement('md-switch') as MaterialSwitchElement;
    input.id = id;
    input.selected = selected;
    input.setAttribute('aria-labelledby', labelId);

    const content = document.createElement('span');
    content.className = 'md-switch-row__content';

    const labelSpan = document.createElement('span');
    labelSpan.className = 'md-switch-row__label pels-text-settings-label';
    labelSpan.id = labelId;
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


// ─────────────────────────────────────────────────────────────────────────────
// Drag Handle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a drag handle for sortable lists.
 */
export const createDragHandle = (): HTMLElement => {
    const handle = document.createElement('span');
    handle.className = 'drag-handle';
    // Static icon markup (no interpolation) — kept as a constant string so the
    // `no-unsanitized/property` rule recognises it as safe, not a dynamic sink.
    handle.innerHTML
        = '<svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor">'
        + '<circle cx="3" cy="3" r="1.5"/><circle cx="9" cy="3" r="1.5"/>'
        + '<circle cx="3" cy="8" r="1.5"/><circle cx="9" cy="8" r="1.5"/>'
        + '<circle cx="3" cy="13" r="1.5"/><circle cx="9" cy="13" r="1.5"/>'
        + '</svg>';
    return handle;
};

// ─────────────────────────────────────────────────────────────────────────────
// List Utilities
// ─────────────────────────────────────────────────────────────────────────────

