// Flat-config for the React/Vite frontend. Mirrors backend/eslint.config.js
// rule severities (same 7 warn rules, same eslint-10 parity disables) and
// adds browser globals, JSX support, react-hooks and react-refresh plugins.
//
// react-hooks v7 bundles React Compiler rules (immutability, purity,
// set-state-in-effect, refs, static-components, etc.) in its recommended
// preset. Those rules require significant React refactoring to satisfy.
// We register the plugin manually and enable only the two classic rules
// (rules-of-hooks, exhaustive-deps) that the React team has shipped since
// v4. Compiler rules can be adopted in a follow-up once the codebase is
// React-Compiler-ready.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default [
  // ── ignores ──
  {
    ignores: [
      "dist/**",
      "build/**",
      "node_modules/**",
      "coverage/**",
      "**/*.d.ts",
    ],
  },

  // ── base configs ──
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ── react-refresh (vite preset) ──
  reactRefresh.configs.vite,

  // ── project rules (backend-parity + browser globals + JSX) ──
  {
    plugins: {
      "react-hooks": reactHooks,
    },
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.es2020,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    linterOptions: {
      // parity with backend: eslintrc migration did not report unused
      // eslint-disable directives; flat config defaults this to "warn"
      reportUnusedDisableDirectives: "off",
    },
    rules: {
      // parity with backend: added to eslint:recommended in eslint 10;
      // not enabled under eslint 8 baseline
      "preserve-caught-error": "off",
      "no-useless-assignment": "off",

      // 7 backend-parity warn rules
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

      // Classic react-hooks rules only (not the React Compiler suite)
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",

      // Dev-only HMR hint; component files here co-export helpers by convention
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
];
