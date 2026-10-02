import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    // 第三方壓縮檔與 28MB 資料不檢查；tools/ 是 Python
    ignores: ['vendor/**', 'data/**', 'node_modules/**', '.wrangler/**', '.firebase/**'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        // vendor/ 的傳統 script 掛在 window 上，模組看得到但 ESLint 不知道
        LightweightCharts: 'readonly',
        supabase: 'readonly',
      },
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node },
  },
];
