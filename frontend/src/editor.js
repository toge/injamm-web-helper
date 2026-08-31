/**
 * @file editor.js
 * @brief Mustache/Handlebars テンプレート用 CodeMirror エディタ
 * @details 正規表現ベースの軽量ハイライトとエラー下線、ライト/ダークテーマ切り替えを提供する。
 *          Lezer による完全な AST 解析は行わず、単一パスで高速にデコレーションを生成する。
 */
import { EditorView, Decoration, ViewPlugin } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";

// 正規表現で単一パス、ネストの正確な AST が必要になるまで Lezer は使わない
/** @brief Mustache タグ全体を検出する正規表現（トリプル/ダブル両対応） */
const TAG_RE = /\{\{\{.*?\}\}\}|\{\{.*?\}\}/g;
/** @brief セクション開始・終了・else を判定する正規表現 */
const SECTION_RE = /^(#|\^|\/|else)/;
/** @brief #if ディレクティブを判定する正規表現 */
const IF_RE = /^#if\b/;

/**
 * @brief エディタ内容からハイライト用デコレーションを構築する
 * @param {EditorView} view 対象のエディタビュー
 * @return {DecorationSet} 計算されたデコレーション集合
 * @details テキストが 5000 文字を超える場合はパフォーマンス保護のため装飾をスキップする。
 *          トリプル括弧・セクション・通常変数・フィルタ部分をそれぞれ別クラスでマークする。
 */
function buildDecorations(view) {
  const text = view.state.doc.toString();
  if (text.length > 5000) return Decoration.none; // 5k で打ち切り、巨大テンプレートは仮想化が必要になるまでスキップ
  const decos = [];
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(text)) !== null) {
    const from = m.index; // タグ開始位置
    const to = from + m[0].length; // タグ終了位置
    const isTriple = m[0].startsWith("{{{"); // トリプル括弧か
    const inner = m[0].slice(isTriple ? 3 : 2, isTriple ? -3 : -2).trim(); // 内部文字列
    const isSection = SECTION_RE.test(inner) || IF_RE.test(inner); // セクション系か
    const hasFilter = inner.includes("|"); // フィルタを含むか
    if (isTriple) {
      // 生出力（エスケープなし）: 紫色で強調
      decos.push(Decoration.mark({ class: "cm-triple" }).range(from, to));
    } else if (isSection) {
      // セクション/条件分岐: オレンジ色で強調
      decos.push(Decoration.mark({ class: "cm-section" }).range(from, to));
    } else {
      // 通常変数: 青色で強調
      decos.push(Decoration.mark({ class: "cm-double" }).range(from, to));
    }
    if (hasFilter) {
      // フィルタ部分（| 以降）を緑色で上書きハイライト
      const pipeIdx = m[0].indexOf("|");
      if (pipeIdx !== -1) {
        const fFrom = from + pipeIdx; // フィルタ開始
        // 閉じ括弧の手前までをフィルタ範囲とする
        const fTo = to - (isTriple ? 3 : 2);
        decos.push(Decoration.mark({ class: "cm-filter" }).range(fFrom, fTo));
      }
    }
  }
  return Decoration.set(decos, true);
}

/** @brief テンプレートハイライト用の ViewPlugin */
const highlightPlugin = ViewPlugin.fromClass(
  class {
    /**
     * @param {EditorView} view 初期ビュー
     */
    constructor(view) {
      this.decorations = buildDecorations(view);
    }
    /**
     * @brief ドキュメント変更時にデコレーションを再計算する
     * @param {ViewUpdate} update ビューの更新情報
     */
    update(update) {
      if (update.docChanged || update.viewportChanged) {
        // ドキュメント変更またはビューポート変更時のみ再計算（明示的 dispatch でも発火）
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);

// エラー下線用の共有デコレーション（単一エラーのみ表示）
let errorDeco = Decoration.none;

/**
 * @brief エラー位置に波線下線を設置・解除する
 * @param {EditorView} view 対象ビュー
 * @param {number|null} from 開始位置（null で解除）
 * @param {number|null} to 終了位置（null で解除）
 */
export function setError(view, from, to) {
  if (from == null || to == null) {
    errorDeco = Decoration.none;
  } else {
    errorDeco = Decoration.set([Decoration.mark({ class: "cm-error-underline" }).range(from, to)]);
  }
  // 空の dispatch で ViewPlugin の再描画を強制
  view.dispatch({ effects: [] });
}

// ハイライトとエラー下線を重ねるための別プラグイン（同じ Decoration レイヤに統合しない）
const errorPlugin = ViewPlugin.fromClass(
  class {
    constructor() {}
    update() {}
  },
  {
    decorations: () => errorDeco,
  }
);

/**
 * @brief テンプレートエディタを生成する
 * @param {HTMLElement} parent エディタを配置する親要素
 * @param {string} initialDoc 初期ドキュメント文字列
 * @return {EditorView} 生成されたエディタビュー（setDark/dispatch ヘルパ付き）
 * @details ライト/ダークは `data-theme` 属性を参照して初期化し、Compartment で後から切り替え可能にする。
 */
export function createEditor(parent, initialDoc = "Hello {{name}}!") {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark"; // 現在のテーマ判定
  const themeCompartment = new Compartment(); // テーマ切り替え用の隔離領域
  const state = EditorState.create({
    doc: initialDoc,
    extensions: [highlightPlugin, errorPlugin, EditorView.lineWrapping, themeCompartment.of(isDark ? oneDark : [])],
  });
  const view = new EditorView({ state, parent });
  view._themeCompartment = themeCompartment; // デバッグ/外部操作用に保持
  /** @brief ダークモードを切り替える @param {boolean} dark true でダークテーマ */
  view.setDark = (dark) => view.dispatch({ effects: themeCompartment.reconfigure(dark ? oneDark : []) });
  // コンパイルボタン等から明示的にハイライト再計算を要求するためのヘルパ
  view._recompute = () => {
    view.dispatch({});
  };
  return view;
}

/**
 * @brief WASM 検証エラー位置からエラー範囲を計算する
 * @param {string} tmpl テンプレート文字列
 * @param {number} pos バイトオフセット（WASM 側のエラー位置）
 * @return {{from:number,to:number}} エラー範囲（文字オフセット）
 * @details エラー位置が Mustache タグ内部ならタグ全体を、外なら 1 文字を範囲とする。
 */
export function errorRangeFromPos(tmpl, pos) {
  // 直前の "{{" を探してタグ内部か判定
  const lastOpen = tmpl.lastIndexOf("{{", pos);
  if (lastOpen !== -1) {
    const isTriple = tmpl.slice(lastOpen, lastOpen + 3) === "{{{";
    const close = tmpl.indexOf(isTriple ? "}}}" : "}}", lastOpen + 2);
    if (close !== -1 && close >= pos) {
      return { from: lastOpen, to: close + (isTriple ? 3 : 2) };
    }
  }
  // タグ外の場合は 1 文字だけをエラー範囲とする
  return { from: pos, to: Math.min(pos + 1, tmpl.length) };
}
