# injamm Web Helper

[![Deploy to Pages](https://github.com/toge/injamm-web-helper/actions/workflows/deploy.yml/badge.svg)](https://github.com/toge/injamm-web-helper/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

ブラウザだけで [injamm](https://github.com/toge/injamm) テンプレートの検証・コンパイル・コード生成ができる静的 Web ツールです。
injammをWASMでコンパイルしたものがブラウザ内で動作するため、完全にクライアントサイドでテンプレートの検証・コンパイル・コード生成が可能です。

> Live Demo: `https://toge.github.io/injamm-web-helper/`

## 特長

- **即時検証** : 構文エラーを行・列・波線ハイライトで表示（日本語メッセージ対応）
- **バイトコード出力** : `template.bc`（`IJBC` マジック、version 6）をダウンロード可能
- **逆アセンブル** : バイトコードの命令列を可読なテキストで確認
- **C++ コード生成** : `render.hpp`（`glaze` 連携・`output_sink` 対応）を生成＆プレビュー
- **構造体サンプル** : テンプレートから `struct` 定義と `glz::meta` を自動推論（ネスト / `vector` / フィルタによる型推論対応）
- **ライト/ダークテーマ** : 右上アイコンで切替、`localStorage` と `prefers-color-scheme` に追従、CodeMirror のハイライトも連動
- **完全静的** : `dist/` をそのまま GitHub Pages / Cloudflare Pages にデプロイ可能

## クイックスタート

### 0. 前提

- Emscripten SDK 6+ (`em++`) — WASM ビルド時のみ
- Node.js 20+ / npm
- C++23 ツールチェイン（WASM ビルド時）

### 1. WASM ビルド（初回のみ）

```sh
cmake -B build-wasm -S . -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake \
  -DVCPKG_TARGET_TRIPLET=wasm32-emscripten \
  -DVCPKG_CHAINLOAD_TOOLCHAIN_FILE=$EMSDK/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake \
  -DCMAKE_BUILD_TYPE=Release
cmake --build build-wasm
# -> frontend/public/injamm.js + frontend/public/injamm.wasm
```

### 2. フロントエンド

```sh
cd frontend
npm ci
npm run dev      # http://localhost:5173 で開発サーバ起動
npm run test     # structGen のユニットテスト（6件）
npm run build    # -> ../dist（デプロイ用静的ファイル）
```

`npm run dev` は `frontend/public/injamm.js` を自動配信します。WASM 未ビルドの場合は上記 cmake コマンドでビルドしてください。

## 使い方

1. 左ペインのエディタに Mustache/Handlebars テンプレートを入力（例: `Hello {{name}}! {{#users}}{{name|upper}} {{/users}}`）
2. `Type name` に生成したい C++ 構造体名を入力（既定 `MyData`）
3. `Compile` を押下
   - 成功: 右ペインに Disassembly / `render.hpp` / Struct example が表示され、ダウンロードボタンが有効化
   - 失敗: エラーパネルに行・列と対象行の抜粋、エディタ上に波線が表示

生成物は「Download template.bc」「Download render.hpp」から保存できます。

## プロジェクト構成

```
.
├── CMakeLists.txt        # ルート cmake（wasm サブディレクトリを統括）
├── wasm/
│   ├── injamm_wasm.cpp   # WASM バインディング（validate/compile_bytes/compile_disasm/codegen/analyze_json）
│   ├── codegen.hpp       # バイナリパーサ + C++ コードジェネレータ（glaze 非依存）
│   ├── CMakeLists.txt    # WASM 用 cmake（EMSCRIPTEN 時は injamm.js / 非EMSCRIPTEN時は test_wasm）
│   └── tests/test_wasm.cpp
├── frontend/
│   ├── index.html        # エントリ HTML（テーマ初期化・レイアウト）
│   ├── style.css         # ライト/ダーク CSS 変数・レスポンシブ
│   ├── vite.config.js
│   └── src/
│       ├── main.js       # UI 統括・コンパイルフロー・テーマ切替
│       ├── editor.js     # CodeMirror 軽量ハイライト・エラー装飾
│       ├── wasm.js       # WASM ローダ・Promise API ラッパ
│       └── structGen.js  # var_refs → C++ struct 推論
└── dist/                 # ビルド成果物（デプロイ対象）
```

## WASM API

JavaScript からは `wasm.js` のラッパ経由で呼び出します。

| 関数                      | 説明              | 戻り値                                                            |
| ------------------------- | ----------------- | ----------------------------------------------------------------- |
| `validate(tmpl)`          | 構文検証          | `Promise<{ok, ec, pos, line, col, msg, line_content, formatted}>` |
| `compileBytes(tmpl)`      | バイトコード生成  | `Promise<Uint8Array>`（失敗時 空）                                |
| `compileDisasm(tmpl)`     | 逆アセンブル      | `Promise<string>`                                                 |
| `codegen(tmpl, typeName)` | `render.hpp` 生成 | `Promise<string>`                                                 |
| `analyzeJson(tmpl)`       | 変数参照解析      | `Promise<Array<VarRef>>`                                          |

`VarRef`（抜粋）: `key`, `has_dot`, `is_section`, `is_inverted`, `is_inside`, `parent_section`, `filters`, `int_filters`, `compare_rhs_kind` など。

## 開発

```sh
# フロントのみの高速イテレーション（WASM は既存の public/injamm.js を再利用）
cd frontend && npm run dev

# テスト
npm run test

# Lint 的な簡易チェック（ビルドが通れば OK）
npm run build
```

C++ 側のテスト（Catch2）:

```sh
cmake -B build -S . -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake
cmake --build build && ctest --test-dir build
```

WASM ビルド:

```sh
cmake -B build-wasm -S . -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake \
  -DVCPKG_TARGET_TRIPLET=wasm32-emscripten \
  -DVCPKG_CHAINLOAD_TOOLCHAIN_FILE=$EMSDK/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake \
  -DCMAKE_BUILD_TYPE=Release
cmake --build build-wasm
# -> frontend/public/injamm.js + frontend/public/injamm.wasm
```

## デプロイ

### GitHub Pages

`main` ブランチへの push で `.github/workflows/deploy.yml` が自動実行されます。

1. `emsdk` セットアップ → `cmake -B build-wasm -S . -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake -DVCPKG_TARGET_TRIPLET=wasm32-emscripten -DVCPKG_CHAINLOAD_TOOLCHAIN_FILE=$EMSDK/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake -DCMAKE_BUILD_TYPE=Release && cmake --build build-wasm`
2. `npm ci && npm run test && npm run build`
3. `dist/` を `actions/upload-pages-artifact` でアップロード → `deploy-pages`

リポジトリ Settings → Pages で Source を `GitHub Actions` に設定してください。

### Cloudflare Pages

Build command: `cmake -B build-wasm -S . -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake -DVCPKG_TARGET_TRIPLET=wasm32-emscripten -DVCPKG_CHAINLOAD_TOOLCHAIN_FILE=$EMSDK/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake -DCMAKE_BUILD_TYPE=Release && cmake --build build-wasm && cd frontend && npm ci && npm run build`
Output directory: `dist`

## ライセンス

MIT — 詳細は [LICENSE](LICENSE) を参照。

## 貢献

Issue / Pull Request を歓迎します。日本語・英語どちらでも構いません。バグ報告時はテンプレート本文と期待される出力（またはエラーメッセージ）を添えてください。
