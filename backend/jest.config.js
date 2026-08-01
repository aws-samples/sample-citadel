module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: [
    "<rootDir>/src",
    "<rootDir>/test",
    "<rootDir>/scripts",
    "<rootDir>/lib",
  ],
  testMatch: ["**/__tests__/**/*.ts", "**/?(*.)+(spec|test).ts"],
  testPathIgnorePatterns: [
    "/node_modules/",
    "<rootDir>/cdk.out/",
    "<rootDir>/dist/",
    "<rootDir>/src/lambda/__tests__/fixtures/",
    "<rootDir>/src/utils/__tests__/.*-helper\\.ts$",
  ],
  modulePathIgnorePatterns: [
    "<rootDir>/cdk.out/",
    "<rootDir>/dist/",
    "<rootDir>/coverage/",
  ],
  watchPathIgnorePatterns: [
    "<rootDir>/cdk.out/",
    "<rootDir>/dist/",
    "<rootDir>/coverage/",
    "<rootDir>/node_modules/",
  ],
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: {
          types: ["jest", "node"],
          esModuleInterop: true,
          skipLibCheck: true,
          isolatedModules: true,
        },
      },
    ],
  },
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/**/*.d.ts",
    "!src/**/__tests__/**",
    "!src/**/test/**",
  ],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "lcov", "html"],
  setupFilesAfterEnv: ["<rootDir>/test/setup.ts"],
  testTimeout: 30000,
  maxWorkers: "50%",
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },
};
