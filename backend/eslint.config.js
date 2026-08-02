// Flat-config migration of .eslintrc.json (eslint 8 -> 10). Behavior parity,
// not improvement: same extends chain, same 7 warn rules, same ignores, no
// type-aware linting.
const js = require("@eslint/js");
const tseslint = require("typescript-eslint");
const globals = require("globals");

module.exports = [
  // ignorePatterns parity
  {
    ignores: [
      "dist/**",
      "cdk.out/**",
      "node_modules/**",
      "**/*.d.ts",
      "coverage/**",
    ],
  },
  // extends: eslint:recommended
  js.configs.recommended,
  // extends: plugin:@typescript-eslint/recommended
  // (flat array: base parser setup + eslint-recommended overrides + recommended rules)
  ...tseslint.configs.recommended,
  {
    // env { node, es2020 } + parserOptions { ecmaVersion: 2020, sourceType: "module" }
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.es2020,
      },
    },
    linterOptions: {
      // parity with eslintrc migration: eslintrc did not report unused
      // eslint-disable directives; flat config defaults this to "warn"
      reportUnusedDisableDirectives: "off",
    },
    rules: {
      // parity with eslintrc migration: added to eslint:recommended in
      // eslint 10; not enabled under eslint 8 baseline
      "preserve-caught-error": "off",
      // parity with eslintrc migration: added to eslint:recommended in
      // eslint 10; not enabled under eslint 8 baseline
      "no-useless-assignment": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-require-imports": "warn",
      "prefer-const": "warn",
      "no-case-declarations": "warn",
      "no-inner-declarations": "warn",
      "no-useless-escape": "warn",
    },
  },
];
