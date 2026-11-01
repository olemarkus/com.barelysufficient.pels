type ToggleOpt<T extends string> = {
  value: T;
  label: string;
  /**
   * Optional shorter label rendered at narrow widths (≤360 px) when the full
   * label would otherwise wrap mid-word. The full `label` is preserved as the
   * button's accessible name via `aria-label` so screen readers always speak
   * the unabbreviated word.
   */
  shortLabel?: string;
  disabled?: boolean;
  title?: string;
};

type SegmentedControlProps<T extends string> = {
  options: ToggleOpt<T>[];
  value: T;
  ariaLabel: string;
  contentSized?: boolean;
  onChange: (v: T) => void;
};

export const SegmentedControl = <T extends string>({
  options,
  value,
  ariaLabel,
  contentSized = false,
  onChange,
}: SegmentedControlProps<T>) => (
  <div class={contentSized ? 'segmented segmented--content-sized' : 'segmented'} role="group" aria-label={ariaLabel}>
    {options.map((opt) => (
      <button
        key={opt.value}
        type="button"
        class="segmented__option hy-nostyle"
        aria-pressed={value === opt.value}
        aria-label={opt.shortLabel ? opt.label : undefined}
        disabled={opt.disabled}
        title={opt.title}
        onClick={() => onChange(opt.value)}
      >
        {opt.shortLabel ? (
          <>
            <span class="segmented__option-label segmented__option-label--full" aria-hidden="true">
              {opt.label}
            </span>
            <span class="segmented__option-label segmented__option-label--short" aria-hidden="true">
              {opt.shortLabel}
            </span>
          </>
        ) : (
          opt.label
        )}
      </button>
    ))}
  </div>
);

