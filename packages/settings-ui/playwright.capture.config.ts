import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config.ts';

export default defineConfig({
  ...baseConfig,
  testIgnore: [],
  testMatch: ['**/*screenshot*.spec.ts'],
  workers: 1,
  projects: baseConfig.projects?.filter((project) => project.name === 'chromium-mobile-width'),
});
