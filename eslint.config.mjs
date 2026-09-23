import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/", "node_modules/", "coverage/"],
  },
  {
    rules: {
      "no-console": "warn",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  // Browser frontend: plain ES modules, no TypeScript.
  // Linted as modules so that duplicate top-level declarations (a fatal
  // SyntaxError in a module, which silently kills the whole page) are caught.
  {
    files: ["public/**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        window: "readonly",
        document: "readonly",
        fetch: "readonly",
        crypto: "readonly",
        console: "readonly",
        alert: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        sessionStorage: "readonly",
        indexedDB: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        Uint8Array: "readonly",
        btoa: "readonly",
        atob: "readonly",
      },
    },
    rules: {
      // Handlers are attached to `window.*` and called bare from inline
      // onclick attributes, so these two rules are pure noise here.
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "off",
      // The one that matters: a duplicate top-level declaration is a fatal
      // SyntaxError in an ES module and silently kills the entire page.
      "no-redeclare": "error",
    },
  }
);
