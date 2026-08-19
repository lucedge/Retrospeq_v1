import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "coverage/**",
    // Vendored spec/reference material, not this project's own code -
    // see AGENTS.md "Source of truth" / "Working with the owner".
    "retrospeq-design-system/**",
    "module-docs-github/**",
    "reference/**",
  ]),
]);

export default eslintConfig;
