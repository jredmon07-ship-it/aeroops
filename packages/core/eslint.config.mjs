// ESLint 9 flat config: @eslint/js + typescript-eslint recommended.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "dist/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The codebase carries inline `eslint-disable no-console` / `no-var`
    // comments documenting deliberate console output and `declare global var`
    // usage. Those rules are not enabled here, so don't flag the comments.
    linterOptions: { reportUnusedDisableDirectives: "off" },
  },
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // A leading underscore marks an intentionally unused binding.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    // Tests inspect raw driver rows and build Proxy-based test doubles where
    // `any` is the honest type; production code stays under the rule.
    files: ["**/__tests__/**", "**/*.test.ts", "**/*.test.tsx"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
