module.exports = {
  ...require('./jest.config.js'),
  testMatch: ['**/__tests__/**/*.integration.ts', '**/?(*.)+(integration).test.ts'],
  testTimeout: 60000,
  setupFilesAfterEnv: ['<rootDir>/test/integration-setup.ts'],
};