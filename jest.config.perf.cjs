const fastConfig = require('./jest.config.fast.cjs');

/** @type {import('jest').Config} */
module.exports = {
  ...fastConfig,
  testMatch: ['<rootDir>/test/**/*.perf.test.ts'],
  maxWorkers: 1,
  silent: false,
};
