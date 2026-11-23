// Root-level Jest config — scoped to repo-root scripts/__tests__/*.test.js
// guard tests only (plain JS, no transform needed). This is distinct from
// backend/jest.config.js (ts-jest, backend/scripts) and frontend's own
// jest config; it exists so lightweight cross-cutting guard tests (e.g.
// toolchain-version parity across CI/Docker/buildspecs/docs) can live at
// the repo root without pulling the whole backend workspace into scope.
module.exports = {
  testEnvironment: 'node',
  rootDir: __dirname,
  roots: ['<rootDir>/scripts/__tests__'],
  testMatch: ['**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/'],
};
