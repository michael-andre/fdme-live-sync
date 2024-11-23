// @ts-check
import eslint from "@eslint/js";
import { config, configs as tsLintConfigs } from "typescript-eslint";

export default config(
  eslint.configs.recommended,
  ...tsLintConfigs.strictTypeChecked,
  ...tsLintConfigs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mjs"]
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "quotes": ["error", "double"],
      "max-len": ["error", 120],
    },
  },
  {
    ignores: [
      "dist/*"
    ]
  }
);