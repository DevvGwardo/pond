// Flat ESLint config (package is "type": "module", so flat config, not .eslintrc).
// tsc --strict is the source of truth for types; ESLint adds correctness rules
// (react-hooks) and catches a few footguns tsc doesn't. It runs on hand-written
// .ts/.tsx/.mjs source — the in-place tsc output (*.js / *.d.ts) and the
// generated UI bundle blobs are ignored.
import tseslint from "typescript-eslint"
import reactHooks from "eslint-plugin-react-hooks"

export default tseslint.config(
  {
    ignores: [
      "node_modules/",
      "dist/",
      ".claude/",
      "output/",
      "**/*.js",
      "**/*.d.ts",
      "**/*.js.map",
      "**/*.d.ts.map",
      "src/dashboard/built.ts",
      "src/ide/built.ts",
      "templates/",
    ],
  },
  ...tseslint.configs.recommended,
  {
    // Baseline rule tuning for every linted file (source + .mjs tests).
    rules: {
      // The runtime deals with untrusted JSON at trust boundaries where `any` and
      // explicit casts are deliberate; tsc --strict already guards real type bugs.
      "@typescript-eslint/no-explicit-any": "off",
      // tsc is authoritative for unused symbols (and the codebase keeps some
      // intentional ones); keep this advisory and allow `_`-prefixed names.
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // Empty catch blocks are an intentional best-effort idiom throughout.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
)
