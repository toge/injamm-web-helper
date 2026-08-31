/**
 * @file vite.config.js
 * @brief Vite ビルド設定
 * @details フロントエンドの開発サーバ・ビルド・テスト設定を定義する。
 *          GitHub Pages 配下でも動作するよう base を相対パスにしている。
 */
import { defineConfig } from 'vite';

export default defineConfig({
  root: '.', // プロジェクトルート（index.html の位置）
  base: './', // 相対パス基準（サブパス配下での配信に対応）
  publicDir: 'public', // 静的アセットの配置ディレクトリ（injamm.js 等）
  build: {
    outDir: '../dist', // ビルド出力先
    emptyOutDir: true, // 出力前にディレクトリを空にする
  },
  test: {
    environment: 'node', // Vitest の実行環境
    include: ['src/**/*.test.js'], // テスト対象ファイルのパターン
  },
});
