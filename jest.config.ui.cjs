/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node', // Puppeteer requires node environment
  moduleFileExtensions: ['ts', 'js', 'json'],
  roots: ['<rootDir>/test'],
  testMatch: ['**/settings-ui.test.ts'],
  testTimeout: 30000,
  clearMocks: true,
};
