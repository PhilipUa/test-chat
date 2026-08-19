import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Three kinds of code live here, and each gets the strictest config it can honestly carry:
 *
 *  - src/, docker/db/  TypeScript under `strict` — type-aware linting (floating promises, unsafe
 *                      any flows) is where the real bugs in an async codebase hide.
 *  - scripts/, tests/  Plain Node ESM. No types to lean on, so the recommended set plus Node globals.
 *  - web/              Browser ESM served as-is, no bundler. Browser globals.
 *
 * `eslint-config-prettier` comes last so formatting stays Prettier's job and the linter never
 * argues with it.
 */
export default tseslint.config(
  {
    ignores: ['node_modules/', 'postman/', '.idea/', '.playwright-mcp/', 'src/generated/'],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: {
          // scripts/*.ts are outside tsconfig's include; lint them against a default project.
          allowDefaultProject: ['scripts/*.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: globals.node,
    },
    rules: {
      // The codebase narrows external data (MySQL rows, parsed JSON) through interfaces at the
      // boundary; require-await and unbound-method stay, but these three fire on every legitimate
      // boundary cast and would train people to sprinkle disables.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      // A leading underscore is the codebase's spelling for "required by the signature, unused on
      // purpose" — Express error handlers need their 4th parameter to be recognised at all.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs', 'tests/**/*.mjs', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // These drive a real browser via Playwright; the `document`/`window` references live inside
    // page.evaluate callbacks that execute in the page, not in Node.
    files: ['tests/ui*.test.mjs', 'scripts/probe-failover.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['web/js/**/*.js'],
    languageOptions: { globals: globals.browser },
  },
  prettier,
);
