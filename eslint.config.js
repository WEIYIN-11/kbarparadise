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
    rules: {
      // 這個 codebase 刻意用空的 catch 吞掉「失敗也不影響功能」的操作
      // （cookie 被封鎖、localStorage 滿了、圖表元件已被銷毀），
      // 而且每一處旁邊都有註解寫明為什麼可以忽略。把它當錯誤只會製造雜訊。
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { caughtErrors: 'none' }],
      // 防禦性的初始值（let closed = 0, cancelled = 0）即使每個分支都會覆寫，
      // 留著比拿掉安全：日後多一個分支忘了賦值就是 undefined 進到訊息裡。
      'no-useless-assignment': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node },
  },
];
