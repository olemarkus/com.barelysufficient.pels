/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node', // Puppeteer requires node environment
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^echarts/core(\\.js)?$': '<rootDir>/test/mocks/echarts-subpath-shim.ts',
    '^echarts/charts(\\.js)?$': '<rootDir>/test/mocks/echarts-subpath-shim.ts',
    '^echarts/components(\\.js)?$': '<rootDir>/test/mocks/echarts-subpath-shim.ts',
    '^echarts/renderers(\\.js)?$': '<rootDir>/test/mocks/echarts-subpath-shim.ts',
  },
  roots: ['<rootDir>/test'],
  testMatch: ['**/settings-ui.test.ts'],
  testTimeout: 30000,
  clearMocks: true,
};
