import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  {
    ignores: ["dist/**", "build/**", "coverage/**", "node_modules/**"],
  },
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      // Indent with 2 spaces
      indent: ['error', 2, { SwitchCase: 1 }],
      'no-tabs': 'error',
      'no-mixed-spaces-and-tabs': 'error',

      // Use single quotes for strings
      quotes: ['error', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
      semi: ['error', 'always'],
    },
  },
  tseslint.configs.recommended,
  {
    files: ["test/**/*.ts"],
    rules: {
      // test doubles are cast to the Homebridge and WLED types they stand in for
      '@typescript-eslint/no-explicit-any': 'off',
      // jest.mock() factories are hoisted above the imports and have to use require()
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
]);
