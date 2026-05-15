import type { Locator, Page } from '@playwright/test';

export const setMdValue = async (page: Page, selector: string, value: string) => {
  await page.locator(selector).evaluate((el, nextValue) => {
    const target = el as HTMLElement & { value: string };
    target.value = nextValue;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
};

export const readMdValue = async (page: Page, selector: string): Promise<string> => (
  page.locator(selector).evaluate((el) => (el as HTMLElement & { value: string }).value)
);

/**
 * Read the text rendered inside the closed field of an `md-filled-select`.
 *
 * Material Web renders the selected option's headline into `#label` in the
 * select's shadow root, sourced from `this.displayText`. A blank string here
 * means the field is rendering empty — the regression we're guarding against.
 */
export const readMdSelectHeadlineText = async (page: Page, selector: string): Promise<string> => (
  page.locator(selector).evaluate((el) => {
    const labelEl = el.shadowRoot?.querySelector('#label') as HTMLElement | null;
    return (labelEl?.textContent ?? '').trim();
  })
);

export const setMdSwitch = async (page: Page, selector: string, selected: boolean) => {
  await page.locator(selector).evaluate((el, nextSelected) => {
    const target = el as HTMLElement & { selected: boolean };
    target.selected = nextSelected;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, selected);
};

export const readMdSwitchSelected = async (page: Page, selector: string): Promise<boolean> => (
  page.locator(selector).evaluate((el) => (el as HTMLElement & { selected: boolean }).selected)
);

export const setMdCheckbox = async (locator: Locator, checked: boolean) => {
  await locator.evaluate((el, nextChecked) => {
    const target = el as HTMLElement & { checked: boolean };
    target.checked = nextChecked;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, checked);
};

export const readMdCheckboxChecked = async (locator: Locator): Promise<boolean> => (
  locator.evaluate((el) => (el as HTMLElement & { checked: boolean }).checked)
);
