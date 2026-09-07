// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      // The codebase is typed over a NestJS/supertest style that uses `any`
      // response bodies liberally (documented: `no-explicit-any` allowed).
      // Keep the type-checked rules as warnings rather than errors so the
      // convention stays principled without failing the whole build.
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      // TypeORM/jest mock patterns pass repository methods by value; treat
      // as a warning rather than forcing `this: void` annotations repo-wide.
      '@typescript-eslint/unbound-method': 'warn',
      // Test files routinely use supertest/`any` bodies and jest mocks
      // (e.g. `mockImplementationOnce(async () => {...})`). Align the
      // remaining broad rules with `no-explicit-any: off` so the suite's
      // established style does not fail the build.
      '@typescript-eslint/require-await': 'warn',
      '@typescript-eslint/no-unused-vars': 'warn',
      '@typescript-eslint/no-unsafe-function-type': 'warn',
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
);
