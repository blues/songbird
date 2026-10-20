/* eslint-env node */
// Flat/legacy ESLint config for the Songbird dashboard.
// Restores the CI lint gate documented in CLAUDE.md (previously non-functional:
// no config existed at all — see review finding H2). ESLint 8 + the legacy
// `--ext ts,tsx` CLI flag means the .eslintrc format is required here.
module.exports = {
  root: true,
  env: { browser: true, es2020: true, node: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint', 'react-hooks', 'react-refresh'],
  settings: {
    react: { version: '18.2' },
  },
  ignorePatterns: [
    'dist',
    'coverage',
    'node_modules',
    'vite.config.ts',
    'vitest.config.ts',
    'tailwind.config.js',
    'postcss.config.js',
    '.eslintrc.cjs',
  ],
  rules: {
    // Hook correctness is the highest-value rule this gate restores — keep it hard.
    'react-hooks/rules-of-hooks': 'error',
    // Runs and reports (the review flagged that this rule "never runs"); kept a
    // warning because the existing tree has ~10 pre-existing violations that are
    // behavior-neutral and out of scope for the lint-gate fix.
    'react-hooks/exhaustive-deps': 'warn',
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],
    // Tracked as review finding L9 ("(x as any) casts defeat strict types").
    // Disabled here so restoring the lint gate does not require touching ~69
    // unrelated call sites in one PR; re-enable when L9 is addressed.
    '@typescript-eslint/no-explicit-any': 'off',
  },
};
