/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^homey$': '<rootDir>/test/mocks/homey.ts',
    '^echarts/core(\\.js)?$': '<rootDir>/test/mocks/echarts-subpath-shim.ts',
    '^echarts/charts(\\.js)?$': '<rootDir>/test/mocks/echarts-subpath-shim.ts',
    '^echarts/components(\\.js)?$': '<rootDir>/test/mocks/echarts-subpath-shim.ts',
    '^echarts/renderers(\\.js)?$': '<rootDir>/test/mocks/echarts-subpath-shim.ts',
  },
  roots: ['<rootDir>/test'],
  testPathIgnorePatterns: ['<rootDir>/test/settings-ui.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  collectCoverage: true,
  collectCoverageFrom: [
    '<rootDir>/**/*.ts',
    '!<rootDir>/test/**',
    '!<rootDir>/settings/**',
    '!<rootDir>/node_modules/**',
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
  clearMocks: true,
  testTimeout: 10000,
  maxWorkers: 1,
  silent: true,
};
