// @ts-check
import js from "@eslint/js";
import tsEsLint from "typescript-eslint";

export default tsEsLint.config(
  js.configs.recommended,
  ...tsEsLint.configs.recommended,
  ...tsEsLint.configs.stylistic,
  {
    rules: {
      "quotes": ["error", "double"],
      "max-len": ["error", 120],
    }
  },
  {
    ignores: [
      "dist/*"
    ]
  }
);
