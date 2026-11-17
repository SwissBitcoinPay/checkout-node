// typescript-eslint's type-aware recommended rules, which catch floating promises and unsafe `any`
// in code that handles money.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/only-throw-error": "off",
      "@typescript-eslint/prefer-promise-reject-errors": "off",
      "no-console": "error"
    }
  },
  {
    // Fakes of async APIs (rate sources, relays) answer at once.
    files: ["test/**"],
    rules: { "@typescript-eslint/require-await": "off", "@typescript-eslint/no-this-alias": "off" }
  },
  {
    files: ["eslint.config.js", "scripts/**"],
    ...tseslint.configs.disableTypeChecked
  },
  {
    // The repository's tooling, run by Node: it reports on the console.
    files: ["scripts/**"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
    rules: { "no-console": "off" }
  }
);
