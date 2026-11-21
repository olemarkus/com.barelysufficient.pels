/**
 * Decimal fields: Material text fields that take a number which may have a
 * decimal part. Every such field is declared `type="text" inputmode="decimal"`
 * (`DECIMAL_FIELD_ATTRIBUTES`), never `type="number"`.
 *
 * In a region whose decimal separator is a comma, a phone's decimal keypad may
 * offer only a comma. A number input can then read the typed `0,25` as empty,
 * so the value never reaches PELS. A text input keeps what was typed, and the
 * one capture listener below turns the comma into a period while the owner
 * types. Every reader of a decimal field therefore sees `0.25`.
 */

export const DECIMAL_FIELD_ATTRIBUTES = { type: 'text', inputmode: 'decimal' } as const;

const DECIMAL_TEXT = /^-?(\d+\.?\d*|\.\d+)$/;

/** The text as a decimal field holds it: a comma reads as a period; only digits, `.` and `-` remain. */
export const normalizeDecimalText = (text: string): string => (
  text.replace(/,/g, '.').replace(/[^0-9.-]/g, '')
);

/** Text the owner has started but that is not a number yet, such as `-` or `.`. */
export const isIncompleteDecimalText = (text: string): boolean => (
  text !== '' && !DECIMAL_TEXT.test(text)
);

/** Make an imperatively built Material text field a decimal field. */
export const markDecimalField = (field: HTMLElement): void => {
  field.setAttribute('type', DECIMAL_FIELD_ATTRIBUTES.type);
  field.setAttribute('inputmode', DECIMAL_FIELD_ATTRIBUTES.inputmode);
};

const isDecimalFieldInput = (target: EventTarget | undefined): target is HTMLInputElement => (
  target instanceof HTMLInputElement
  && target.type === DECIMAL_FIELD_ATTRIBUTES.type
  && target.inputMode === DECIMAL_FIELD_ATTRIBUTES.inputmode
);

// Capture phase: this runs before the text field copies its inner input's text
// into `value` and before any view's own input handler, so neither sees a comma.
const normalizeDecimalInput = (event: Event): void => {
  const input = event.composedPath()[0];
  if (!isDecimalFieldInput(input)) return;
  const text = input.value;
  const normalized = normalizeDecimalText(text);
  if (normalized === text) return;
  const caret = input.selectionStart;
  input.value = normalized;
  if (caret === null) return;
  const nextCaret = normalizeDecimalText(text.slice(0, caret)).length;
  input.setSelectionRange(nextCaret, nextCaret);
};

export const installDecimalFieldInput = (root: Document): void => {
  root.addEventListener('input', normalizeDecimalInput, true);
};
