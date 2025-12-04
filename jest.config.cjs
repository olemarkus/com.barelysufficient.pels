/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^homey$': '<rootDir>/test/mocks/homey.ts',
  },
  roots: ['<rootDir>/test'],
  testPathIgnorePatterns: ['<rootDir>/test/settings-ui.test.ts'],
  clearMocks: true,
  testTimeout: 10000,
  forceExit: true,
};
