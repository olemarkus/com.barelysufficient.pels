// Decimal fields take "0,25" from a keypad whose only separator is a comma and
// hand every reader "0.25". The listener is driven through an open shadow root,
// the way a Material text field wraps its native input.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  installDecimalFieldInput,
  isIncompleteDecimalText,
  normalizeDecimalText,
} from '../src/ui/decimalField.ts';

describe('normalizeDecimalText', () => {
  it.each([
    ['0,25', '0.25'],
    ['0.25', '0.25'],
    ['-1,5', '-1.5'],
    ['0,25 kW', '0.25'],
    ['1 000', '1000'],
    ['', ''],
  ])('reads %j as %j', (text, expected) => {
    expect(normalizeDecimalText(text)).toBe(expected);
  });
});

describe('isIncompleteDecimalText', () => {
  it.each(['-', '.', '-.', '1.2.3', '1-2'])('treats %j as a number not finished yet', (text) => {
    expect(isIncompleteDecimalText(text)).toBe(true);
  });

  it.each(['', '0', '0.25', '-1.5', '.5', '21.'])('accepts %j', (text) => {
    expect(isIncompleteDecimalText(text)).toBe(false);
  });
});

describe('installDecimalFieldInput', () => {
  const buildField = (type: string, inputMode: string) => {
    const host = document.createElement('div');
    const input = document.createElement('input');
    input.type = type;
    input.inputMode = inputMode;
    host.attachShadow({ mode: 'open' }).appendChild(input);
    document.body.appendChild(host);
    return { host, input };
  };

  const typeText = (input: HTMLInputElement, text: string) => {
    input.value = text;
    input.setSelectionRange(text.length, text.length);
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  };

  beforeAll(() => {
    installDecimalFieldInput(document);
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('turns a typed comma into a period before the field and view handlers read it', () => {
    const { host, input } = buildField('text', 'decimal');
    const seen: string[] = [];
    input.addEventListener('input', () => seen.push(input.value));
    host.addEventListener('input', () => seen.push(input.value));

    typeText(input, '0,25');

    expect(seen).toEqual(['0.25', '0.25']);
    expect(input.selectionStart).toBe(4);
  });

  it('keeps the caret where it was when an earlier character is dropped', () => {
    const { input } = buildField('text', 'decimal');
    input.value = '1 0,5';
    input.setSelectionRange(3, 3);
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));

    expect(input.value).toBe('10.5');
    expect(input.selectionStart).toBe(2);
  });

  it('leaves other text fields alone', () => {
    const { input } = buildField('text', 'text');
    typeText(input, 'Step 1,5');
    expect(input.value).toBe('Step 1,5');
  });
});

describe('decimal field declarations', () => {
  const root = join(__dirname, '..');
  const sources = [
    join(root, 'public/index.html'),
    ...readdirSync(join(root, 'src/ui'), { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.tsx?$/.test(file))
      .map((file) => join(root, 'src/ui', file)),
  ];

  // A number input cannot take a comma-region keypad's "0,25", so a field that
  // asks for a decimal keypad is a decimal field (`MdDecimalField`,
  // `markDecimalField`, or `type="text" inputmode="decimal"` in markup).
  it('declares no number input with a decimal keypad', () => {
    const offenders = sources.flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      const tags = text.match(/<(?:md-filled-text-field|MdFilledTextField)\b[^>]*>/g) ?? [];
      return tags
        .filter((tag) => /type="number"/.test(tag) && /input[mM]ode="decimal"/.test(tag))
        .map((tag) => `${file}: ${tag.slice(0, 80)}`);
    });
    expect(offenders).toEqual([]);
  });
});
