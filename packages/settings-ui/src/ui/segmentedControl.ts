export type MaterialSegmentedSelectElement = HTMLElement & {
    value: string;
    disabled: boolean;
};

type SegmentedOptionElement = HTMLElement & {
    value: string;
    disabled: boolean;
};

type MaterialButtonElement = HTMLElement & {
    disabled: boolean;
    focus: () => void;
};

/**
 * Binds a segmented control container ([role="radiogroup"]) to a sibling
 * md-filled-select. The select stays the source of truth: option text, value,
 * hidden, and disabled state propagate to the visible buttons. Clicking a
 * button updates the select's value and dispatches a change event so existing
 * select-change handlers still work.
 */
export const bindSegmentedToSelect = (params: {
    container: HTMLElement;
    select: MaterialSegmentedSelectElement;
}): { refresh: () => void } => {
    const { container, select } = params;
    const buttons = new Map<SegmentedOptionElement, MaterialButtonElement>();

    const isInteractive = (button: MaterialButtonElement) => !button.disabled && !button.hidden;

    const getOptions = () => Array.from(
        select.querySelectorAll<SegmentedOptionElement>('md-select-option'),
    );

    const getOptionLabel = (option: SegmentedOptionElement) => (
        option.querySelector<HTMLElement>('[slot="headline"]')?.textContent
        || option.textContent
        || option.value
    );

    const visibleEnabledOptions = () => (select.disabled ? [] : getOptions().filter((option) => (
        !option.hidden && !option.disabled
    )));

    const focusOption = (option: SegmentedOptionElement) => {
        const button = buttons.get(option);
        if (!button) return;
        select.value = option.value;
        render();
        button.focus();
        select.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const handleKeydown = (event: KeyboardEvent, option: SegmentedOptionElement) => {
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

    const createButton = (option: SegmentedOptionElement): MaterialButtonElement => {
        const button = document.createElement('md-text-button') as MaterialButtonElement;
        button.setAttribute('type', 'button');
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
        const options = getOptions();
        const seen = new Set<SegmentedOptionElement>();
        container.setAttribute('aria-disabled', select.disabled ? 'true' : 'false');
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
            const label = getOptionLabel(option);
            if (button.textContent !== label) button.textContent = label;
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

        buttons.forEach((button, option) => {
            if (seen.has(option)) return;
            button.remove();
            buttons.delete(option);
        });
    };

    render();
    select.addEventListener('change', render);
    select.addEventListener('pels:segmented-refresh', render as EventListener);
    return { refresh: render };
};
