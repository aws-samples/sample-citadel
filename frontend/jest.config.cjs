module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.ts', '**/__tests__/**/*.tsx', '**/?(*.)+(spec|test).ts', '**/?(*.)+(spec|test).tsx'],
  transform: {
    '^.+\\.(ts|tsx|js|jsx|mjs)$': ['ts-jest', {
      tsconfig: 'tsconfig.jest.json',
    }],
  },
  coverageProvider: 'v8',
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/__tests__/**',
    '!src/**/test/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // Wave 3.B: stub CSS imports (e.g. `@xyflow/react/dist/style.css`)
    // so jest doesn't try to parse stylesheets as JavaScript. Real CSS
    // is bundled by Vite at build time.
    '\\.css$': '<rootDir>/src/__mocks__/styleMock.cjs',
  },
  testTimeout: 30000,
  setupFiles: ['<rootDir>/src/test-setup.ts'],
  testPathIgnorePatterns: [
    '/node_modules/',
    '\\.example\\.ts$',
    'error-handling-validation\\.ts$',
    'integrationHelpers\\.ts$',
  ],
  transformIgnorePatterns: [
    'node_modules/(?!(react-markdown|vfile|micromark|mdast|unist|hast|remark|rehype|unified|bail|trough|extend|is-plain-obj|trim-lines|character-entities|character-reference-invalid|decode-named-character-reference|space-separated-tokens|comma-separated-tokens|property-information|html-url-attributes|web-namespaces|zwitch|inline-style-parser|style-to-object|estree-util-is-identifier-name|escape-string-regexp|markdown-table|longest-streak|stringify-entities|github-slugger|html-void-elements|repeat|map-obj|change-case|capitalize|markdown-extensions|stripBomBuf|ccount|devlop)[^/]*/)',
  ],
};
