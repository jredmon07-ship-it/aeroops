// ESLint 9 flat config: @eslint/js + typescript-eslint recommended, plus
// Next's core-web-vitals rules and the React hooks rules.
import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", ".next/**", "out/**", "coverage/**", "next-env.d.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The codebase carries inline `eslint-disable no-console` / `no-var`
    // comments documenting deliberate console output and `declare global var`
    // usage. Those rules are not enabled here, so don't flag the comments.
    linterOptions: { reportUnusedDisableDirectives: "off" },
  },
  {
    plugins: { "@next/next": nextPlugin, "react-hooks": reactHooks },
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    settings: { next: { rootDir: "." } },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      ...reactHooks.configs.recommended.rules,
      // A leading underscore marks an intentionally unused binding.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      // shadcn/ui components declare `interface XProps extends
      // React.HTMLAttributes<...> {}` as an extension point.
      "@typescript-eslint/no-empty-object-type": ["error", { allowInterfaces: "with-single-extends" }],
    },
  },
  {
    // Tests inspect raw driver rows and build Proxy-based test doubles where
    // `any` is the honest type; production code stays under the rule.
    files: ["**/__tests__/**", "**/*.test.ts", "**/*.test.tsx"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
