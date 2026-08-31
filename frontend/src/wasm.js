/**
 * @file wasm.js
 * @brief WASM モジュール読み込みと injamm API のラッパー
 * @details ブラウザでは `injamm.js` を動的に読み込み、Node.js では `require` で読み込む。
 *          すべての API は Promise ベースで提供し、将来的に Crow サーバ等の fetch へ
 *          差し替える場合でも呼び出し側を変更せずに済むように抽象化している。
 */

// WASM インスタンス（初期化後に保持）
let mod = null;
// 初期化 Promise（多重初期化を防止）
let ready = null;

/**
 * @brief injamm WASM モジュールの factory 関数を取得する
 * @details ブラウザ環境では `document` 上に script タグを注入して `createInjammModule` を待機する。
 *          Node 環境では `eval("require")` を隠蔽して Vite の静的解析を回避しつつ require する。
 * @return {Promise<Function|null>} factory 関数。見つからない場合は null
 */
async function loadCreateModule() {
  // 既にグローバルに存在すれば即返す
  if (typeof globalThis.createInjammModule === "function") return globalThis.createInjammModule;
  // ブラウザ: script 注入で読み込み（GH Pages のサブパス対応のため複数候補を試す）
  if (typeof document !== "undefined") {
    const candidates = ["./injamm.js", "injamm.js", "/injamm.js"];
    for (const src of candidates) {
      // 既にタグが存在すれば少し待機してグローバルの出現を確認
      if (document.querySelector(`script[src="${src}"]`)) {
        await new Promise((r) => setTimeout(r, 50));
        if (typeof globalThis.createInjammModule === "function") return globalThis.createInjammModule;
      }
    }
    // 新規に script タグを生成して非同期読み込み
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "./injamm.js";
      s.onload = () => resolve(globalThis.createInjammModule);
      s.onerror = () => {
        // フォールバック: 相対パスなしで再試行
        const s2 = document.createElement("script");
        s2.src = "injamm.js";
        s2.onload = () => resolve(globalThis.createInjammModule);
        s2.onerror = () => reject(new Error("failed to load injamm.js"));
        document.head.appendChild(s2);
      };
      document.head.appendChild(s);
    });
  }
  // Node.js フォールバック: require を隠蔽（Vite に検出させない）
  try {
    if (typeof require !== "undefined") {
      const _req = (0, eval)("require");
      const m = _req("../../public/injamm.js");
      if (m) return m.default || m.createInjammModule || m;
    }
  } catch {}
  if (typeof globalThis.createInjammModule === "function") return globalThis.createInjammModule;
  return null;
}

/**
 * @brief WASM モジュールを初期化する
 * @details 初回のみ factory を呼び出し、以降はキャッシュされたインスタンスを返す。
 *          同時呼び出しは同一 Promise を共有して多重初期化を防ぐ。
 * @return {Promise<any>} 初期化済み WASM モジュール
 */
export async function initWasm() {
  if (mod) return mod;
  if (ready) return ready;
  ready = (async () => {
    const createModule = await loadCreateModule();
    if (!createModule) throw new Error("injamm.js not found. Run wasm/build-wasm.sh");
    mod = await createModule();
    return mod;
  })();
  return ready;
}

// ----- Promise ベースの抽象 API（将来的に fetch へ差し替え可能） -----

/**
 * @brief テンプレートの構文検証を行う
 * @param {string} tmpl テンプレート文字列
 * @return {Promise<Object>} JSON パース済みの検証結果（ok/ec/pos/line/col/msg 等）
 */
export async function validate(tmpl) {
  const m = await initWasm();
  const jsonStr = m.validate(tmpl);
  return JSON.parse(jsonStr);
}

/**
 * @brief テンプレートをバイトコードへコンパイルする
 * @param {string} tmpl テンプレート文字列
 * @return {Promise<Uint8Array>} バイトコードのバイト列。失敗時は空配列
 */
export async function compileBytes(tmpl) {
  const m = await initWasm();
  return m.compile_bytes(tmpl); // Uint8Array
}

/**
 * @brief バイトコードの逆アセンブル文字列を取得する
 * @param {string} tmpl テンプレート文字列
 * @return {Promise<string>} 逆アセンブル結果。失敗時は空文字
 */
export async function compileDisasm(tmpl) {
  const m = await initWasm();
  return m.compile_disasm(tmpl);
}

/**
 * @brief バイトコードから C++ レンダリングヘッダを生成する
 * @param {string} tmpl テンプレート文字列
 * @param {string} typeName 生成するデータ型名
 * @return {Promise<string>} render.hpp の内容。失敗時は空文字
 */
export async function codegen(tmpl, typeName) {
  const m = await initWasm();
  return m.codegen(tmpl, typeName);
}

/**
 * @brief テンプレート内の変数参照情報を JSON で取得する
 * @param {string} tmpl テンプレート文字列
 * @return {Promise<Array>} var_ref の配列（key/has_dot/filters 等）
 */
export async function analyzeJson(tmpl) {
  const m = await initWasm();
  const s = m.analyze_json(tmpl);
  return JSON.parse(s);
}

/**
 * @brief 初期化済みモジュールを取得する（テスト用の同期アクセス）
 * @return {any|null} WASM モジュール。未初期化なら null
 */
export function getModule() { return mod; }
