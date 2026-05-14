import { expect, test as base } from '@playwright/test';
import { resolveE2EBaseURL } from './baseUrl';

export const test = base.extend({
  baseURL: async ({ browserName }, use) => {
    void browserName;
    await use(resolveE2EBaseURL());
  },
});
export { expect };
export type { Locator, Page } from '@playwright/test';
