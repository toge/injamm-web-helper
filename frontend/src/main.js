/**
 * @file main.js
 * @brief injamm Web Helper のフロントエンドメインロジック
 * @details テンプレートエディタ・コンパイル・コード生成・構造体生成・ダウンロード・
 *          ライト/ダークテーマ切り替えを統括する。WASM はバックグラウンドで初期化される。
 */
import { createEditor, setError, errorRangeFromPos } from "./editor.js";
import { validate, compileBytes, compileDisasm, codegen, analyzeJson, initWasm } from "./wasm.js";
import { generateStruct } from "./structGen.js";
import { EditorState, Compartment, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { cpp } from "@codemirror/lang-cpp";
import { oneDark } from "@codemirror/theme-one-dark";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";

// ----- DOM 要素の取得 -----
const editorParent = document.getElementById("editor"); // テンプレートエディタの親要素
const errorPanel = document.getElementById("error-panel"); // エラーメッセージ表示領域
const outDisasm = document.getElementById("out-disasm"); // 逆アセンブル出力
const codegenParent = document.getElementById("out-codegen"); // render.hpp 表示領域
const structParent = document.getElementById("out-struct"); // 構造体例表示領域
const btnCompile = document.getElementById("btn-compile"); // コンパイルボタン
const btnDlBc = document.getElementById("btn-dl-bc"); // template.bc ダウンロードボタン
const btnDlHpp = document.getElementById("btn-dl-hpp"); // render.hpp ダウンロードボタン
const typeNameInput = document.getElementById("typeName"); // 型名入力欄
const btnShare = document.getElementById("btn-share"); // 共有リンクコピーボタン

// テンプレートエディタの生成（初期サンプル付き）
const view = createEditor(editorParent, "Hello {{name}}!\n{{#users}}{{name|upper}} {{/users}}");

// ----- クエリパラメータから初期値を反映 -----
// 例: ?template=Hello%20{{name}}&typeName=MyData  または ?tmpl=...&type=...&class=...
// template/tmpl: テンプレート文字列、typeName/type/className/class: C++ 構造体名
function getQueryParam(params, ...keys) {
  for (const k of keys) if (params.has(k)) return params.get(k);
  return null;
}
const _qParams = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
const _initialTmpl = getQueryParam(_qParams, "template", "tmpl");
const _initialType = getQueryParam(_qParams, "typeName", "type", "className", "class");
if (_initialTmpl !== null) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: _initialTmpl } });
if (_initialType !== null) typeNameInput.value = _initialType;
const _compileParam = getQueryParam(_qParams, "compile", "autocompile", "auto");
// template 指定時はデフォルトで自動コンパイル（compile=0/false で抑制）
const _shouldAutoCompile = _initialTmpl !== null && _compileParam !== "0" && _compileParam !== "false";

// ----- URL 双方向同期 & 共有リンク -----
// 現在のエディタ内容と型名から共有URLを構築する（canonical: template + typeName）
function buildShareUrl() {
  const url = new URL(location.href);
  const tmpl = view.state.doc.toString();
  const tName = typeNameInput.value.trim();
  if (tmpl) url.searchParams.set("template", tmpl);
  else url.searchParams.delete("template");
  url.searchParams.delete("tmpl");
  if (tName && tName !== "MyData") url.searchParams.set("typeName", tName);
  else url.searchParams.delete("typeName");
  url.searchParams.delete("type");
  url.searchParams.delete("class");
  url.searchParams.delete("className");
  url.searchParams.delete("compile");
  url.searchParams.delete("autocompile");
  url.searchParams.delete("auto");
  return url.toString();
}
// history.replaceState で URL を更新（リロードなし）
function syncUrl() {
  if (typeof history === "undefined" || typeof location === "undefined") return;
  try {
    const newUrl = buildShareUrl();
    if (newUrl !== location.href) history.replaceState(null, "", newUrl);
  } catch {}
}
let _syncTimer = null;
function scheduleSync() {
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(syncUrl, 350);
}
// typeName の入力で URL を同期（即時 debounce）
typeNameInput.addEventListener("input", scheduleSync);
// エディタ内容の変更で URL を同期（CodeMirror updateListener を動的に追加）
try {
  view.dispatch({ effects: StateEffect.appendConfig.of(EditorView.updateListener.of((u) => { if (u.docChanged) scheduleSync(); })) });
} catch {
  // フォールバック: DOM イベントで代替（appendConfig 非対応環境向け）
  view.dom?.addEventListener("keyup", scheduleSync);
  view.dom?.addEventListener("paste", () => setTimeout(scheduleSync, 0));
}

/**
 * @brief 読み取り専用の C++ ビューアを生成する
 * @param {HTMLElement} parent 配置先の親要素
 * @param {string} initial 初期表示テキスト
 * @return {EditorView} 生成されたビュー（setText/setDark 付き）
 * @details cpp 言語サポートとライト/ダークのハイライト切り替えを提供する。
 *          ライト時は defaultHighlightStyle、ダーク時は oneDark を使用する。
 */
function createCppViewer(parent, initial = "(empty)") {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark"; // 初期テーマ判定
  const themeCompartment = new Compartment(); // テーマ差し替え用の Compartment
  const lightHighlight = syntaxHighlighting(defaultHighlightStyle, { fallback: true }); // ライト用ハイライト
  const state = EditorState.create({
    doc: initial,
    extensions: [cpp(), themeCompartment.of(isDark ? oneDark : lightHighlight), EditorView.editable.of(false), EditorView.lineWrapping, EditorView.theme({ "&": { fontSize: "13px" } })],
  });
  const v = new EditorView({ state, parent });
  v._themeCompartment = themeCompartment;
  v._lightHighlight = lightHighlight;
  /** @brief テーマを切り替える @param {boolean} dark true でダーク */
  v.setDark = (dark) => v.dispatch({ effects: themeCompartment.reconfigure(dark ? oneDark : lightHighlight) });
  /** @brief 表示テキストを差し替える @param {string} t 新しいテキスト */
  v.setText = (t) => v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t } });
  return v;
}
const codegenView = createCppViewer(codegenParent); // render.hpp 用ビュー
const structView = createCppViewer(structParent); // 構造体例用ビュー

// ----- テーマ切り替え -----
// localStorage + prefers-color-scheme は <head> の初期化スクリプトで既に設定済み
const themeToggle = document.getElementById("theme-toggle"); // テーマ切り替えボタン
/**
 * @brief 指定テーマを適用し各エディタへ反映する
 * @param {string} theme "light" または "dark"
 */
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem("theme", theme); } catch {} // プライベートモード等での例外を無視
  const isDark = theme === "dark";
  view.setDark(isDark);
  codegenView.setDark(isDark);
  structView.setDark(isDark);
}
themeToggle?.addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme") || "light";
  applyTheme(cur === "dark" ? "light" : "dark"); // 現在と逆のテーマへ切り替え
});

// ----- ダウンロード用の Blob URL 管理 -----
let lastBcBlobUrl = null; // 最後に生成した template.bc の ObjectURL
let lastHppBlobUrl = null; // 最後に生成した render.hpp の ObjectURL
let lastCodegenText = ""; // 最後に生成した render.hpp のテキスト

/**
 * @brief Blob をダウンロードさせる（未使用のヘルパ、互換用に残置）
 * @param {Blob} blob ダウンロード対象
 * @param {string} filename 保存ファイル名
 * @param {{value:string|null}} prevUrlRef 前回の ObjectURL を保持する参照オブジェクト
 */
function downloadBlob(blob, filename, prevUrlRef) {
  if (prevUrlRef.value) URL.revokeObjectURL(prevUrlRef.value);
  const url = URL.createObjectURL(blob);
  prevUrlRef.value = url;
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
}

/**
 * @brief コンパイルボタン押下時のメイン処理
 * @details 検証→エラー表示、成功時はバイトコード/逆アセンブル/コード生成/解析を並列実行し、
 *          結果を各パネルへ反映してダウンロードボタンを有効化する。
 */
async function onCompile() {
  const tmpl = view.state.doc.toString(); // エディタ内容
  const typeName = typeNameInput.value.trim() || "MyData"; // 型名（空なら既定値）
  btnCompile.disabled = true;
  errorPanel.textContent = "compiling…";

  try {
    // ----- 構文検証 -----
    const v = await validate(tmpl);
    if (!v.ok) {
      // バイトオフセットを文字オフセットへ補正（絵文字等のマルチバイト対応）
      let pos = v.pos;
      // ASCII 以外が含まれる場合の補正: エンコード長が一致しないなら文字単位で走査
      const bytesBefore = new TextEncoder().encode(tmpl.slice(0, pos)).length;
      // tmpl にマルチバイト文字が含まれる場合、バイト位置から文字位置へ変換
      if (bytesBefore !== v.pos) {
        let charPos = 0, bytePos = 0;
        for (let ch of tmpl) {
          const enc = new TextEncoder().encode(ch).length;
          if (bytePos + enc > v.pos) break;
          bytePos += enc;
          charPos += ch.length;
        }
        pos = charPos;
      }
      const range = errorRangeFromPos(tmpl, pos);
      setError(view, range.from, range.to); // エディタ上に波線を表示
      errorPanel.textContent = `${v.msg} at ${v.line}:${v.col}\n${v.line_content}\n${" ".repeat((v.col || 1) - 1)}^\n${v.formatted || ""}`;
      outDisasm.textContent = "(compile failed)";
      codegenView.setText("(compile failed)");
      structView.setText("(compile failed)");
      btnDlBc.disabled = true;
      btnDlHpp.disabled = true;
      return;
    }
    // 検証成功: エラー表示をクリア
    setError(view, null, null);
    errorPanel.textContent = "✓ ok";

    // 各種生成を並列実行（低頻度のため逐次でも問題ないが並列で高速化）
    const [bytes, disasm, hpp, varJson] = await Promise.all([
      compileBytes(tmpl),
      compileDisasm(tmpl),
      codegen(tmpl, typeName),
      analyzeJson(tmpl),
    ]);

    // ----- 結果の反映 -----
    outDisasm.textContent = disasm || "(empty)";
    codegenView.setText(hpp || "(empty)");
    lastCodegenText = hpp || "";

    // 構造体生成（varJson から C++ 構造体定義を推論）
    try {
      const structText = generateStruct(varJson, typeName);
      structView.setText(structText);
    } catch (e) {
      structView.setText(`// struct gen error: ${e.message}`);
    }

    // ----- ダウンロード用 Blob の準備 -----
    if (bytes && bytes.length) {
      const blob = new Blob([bytes], { type: "application/octet-stream" });
      // 前回の ObjectURL を解放してリークを防止
      if (lastBcBlobUrl) URL.revokeObjectURL(lastBcBlobUrl);
      lastBcBlobUrl = URL.createObjectURL(blob);
      btnDlBc.disabled = false;
      btnDlBc.onclick = () => {
        const a = document.createElement("a");
        a.href = lastBcBlobUrl;
        a.download = "template.bc";
        a.click();
      };
    } else {
      btnDlBc.disabled = true;
    }
    if (hpp) {
      const blob = new Blob([hpp], { type: "text/plain" });
      if (lastHppBlobUrl) URL.revokeObjectURL(lastHppBlobUrl);
      lastHppBlobUrl = URL.createObjectURL(blob);
      btnDlHpp.disabled = false;
      btnDlHpp.onclick = () => {
        const a = document.createElement("a");
        a.href = lastHppBlobUrl;
        a.download = "render.hpp";
        a.click();
      };
    } else {
      btnDlHpp.disabled = true;
    }
  } catch (e) {
    // WASM 呼び出し自体の例外（モジュール未読み込み等）
    errorPanel.textContent = `WASM error: ${e.message}\n${e.stack || ""}`;
  } finally {
    btnCompile.disabled = false;
  }
}

// コンパイルボタンのイベント登録
btnCompile.addEventListener("click", onCompile);

// 共有リンクコピー（現在の URL を最新状態に同期してからコピー）
btnShare?.addEventListener("click", async () => {
  // debounce 中の変更を即時反映
  clearTimeout(_syncTimer);
  syncUrl();
  const url = buildShareUrl();
  const origLabel = btnShare.textContent;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(url);
    else throw new Error("clipboard unavailable");
    btnShare.textContent = "Copied!";
    setTimeout(() => { btnShare.textContent = origLabel; }, 1500);
  } catch {
    // フォールバック: プロンプトで手動コピーを促す
    window.prompt("共有リンクをコピーしてください:", url);
  }
});

// WASM モジュールをバックグラウンドでウォームアップ（初回コンパイルの体感遅延を削減）
// クエリで template が指定されていれば自動コンパイル（compile=0/false で抑制）
if (_shouldAutoCompile) {
  initWasm().then(() => onCompile()).catch(() => {});
} else {
  initWasm().catch(() => {});
}
