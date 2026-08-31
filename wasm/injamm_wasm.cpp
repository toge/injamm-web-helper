/**
 * @file injamm_wasm.cpp
 * @brief injamm エンジンの WASM バインディング層
 * @details C++ の injamm::engine を Emscripten 経由で JavaScript から呼び出せるようにする。
 *          テンプレート検証・バイトコード生成・逆アセンブル・コード生成・変数解析の
 *          5 つの機能を提供し、ブラウザとネイティブ（テスト用）の両ビルドに対応する。
 */
#include <cstdint>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

#include <glaze/glaze.hpp>
#include <injamm/bytecode_debug.hpp>
#include <injamm/bytecode_io.hpp>
#include <injamm/engine.hpp>
#include <injamm/types.hpp>
#include "codegen.hpp"

#ifdef __EMSCRIPTEN__
#include <emscripten/bind.h>
#include <emscripten/val.h>
#endif

// ----- ダミーコンテキスト（構文検証専用） -----
/**
 * @brief 構文検証用のダミーデータ型
 * @details フィールドは _dummy のみ。任意の変数名でコンパイルが通る（field_index = UINT32_MAX）
 *          が、構文エラー（unexpected_end 等）は正しく報告される。
 *          実際の型チェックはコード生成側で行うため、ここでは構文のみを検証する。
 */
struct Dummy {
  int _dummy{}; /**< ダミーフィールド（未使用） */
};
/** @brief glaze 用の Dummy メタ情報 */
template <>
struct glz::meta<Dummy> {
  static constexpr auto value = glz::object("_dummy", &Dummy::_dummy);
};

namespace {

/**
 * @brief JSON 文字列用にエスケープする
 * @param s 元の文字列ビュー
 * @return エスケープ済み文字列
 * @details ダブルクォート・バックスラッシュ・制御文字を JSON 仕様に従いエスケープする。
 *          制御文字（0x20 未満）は \uXXXX 形式に変換する。
 */
std::string json_escape(std::string_view s) {
  std::string out;
  out.reserve(s.size() + 8); // 余裕を持って確保（エスケープで膨らむため）
  for (char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          char buf[7];
          std::snprintf(buf, sizeof(buf), "\\u%04x", (unsigned)c);
          out += buf;
        } else {
          out += c;
        }
        break;
    }
  }
  return out;
}

/**
 * @brief テンプレートの検証結果を JSON 文字列で生成する
 * @param tmpl テンプレート文字列
 * @return JSON 文字列（ok/ec/pos/line/col/msg/line_content/formatted 等を含む）
 * @details injamm::engine でコンパイルを試み、エラーがあれば位置情報とメッセージを
 *          JSON に詰めて返す。エラー位置は getSourceLocation で行・列に変換する。
 */
std::string make_validate_json(std::string_view tmpl) {
  injamm::engine<Dummy> eng(tmpl); // ダミー型で構文検証
  auto const& bc = eng.get_bytecode();
  auto const& err = bc.error;
  if (err.ec == injamm::error_code::none) {
    // 成功時は最小限の JSON を返す
    return R"({"ok":true,"ec":0,"pos":0,"line":1,"col":1,"msg":"","line_content":""})";
  }
  auto loc = injamm::getSourceLocation(tmpl, err.position); // 行・列と対象行の文字列を取得
  std::string msg = err.message();
  std::string line_cont{loc.line_content};
  // formatError の詳細も含める（パネル表示用）
  std::string j;
  j += "{\"ok\":false";
  j += ",\"ec\":" + std::to_string(static_cast<int>(err.ec));
  j += ",\"pos\":" + std::to_string(err.position);
  j += ",\"line\":" + std::to_string(loc.line);
  j += ",\"col\":" + std::to_string(loc.column);
  j += ",\"msg\":\"" + json_escape(msg) + "\"";
  j += ",\"line_content\":\"" + json_escape(line_cont) + "\"";
  j += ",\"custom\":\"" + json_escape(std::string(err.custom_error_message)) + "\"";
  // 人間可読なフォーマット済みエラー（複数行）
  std::string fmt = injamm::formatError(tmpl, err, "");
  j += ",\"formatted\":\"" + json_escape(fmt) + "\"";
  j += "}";
  return j;
}

/**
 * @brief テンプレートをバイトコードのバイナリへコンパイルする
 * @param tmpl テンプレート文字列
 * @return バイナリのバイト列。エラー時は空ベクタ
 * @details save_bytecode でシリアライズし、ostringstream 経由でバイト列を取得する。
 */
std::vector<uint8_t> do_compile_bytes(std::string_view tmpl) {
  injamm::engine<Dummy> eng(tmpl);
  auto const& bc = eng.get_bytecode();
  if (bc.error.ec != injamm::error_code::none) return {}; // エラー時は空を返す
  std::ostringstream oss(std::ios::binary);
  auto ec = injamm::save_bytecode(bc, oss);
  if (ec != injamm::error_code::none) return {};
  std::string s = oss.str();
  return std::vector<uint8_t>(s.begin(), s.end());
}

/**
 * @brief バイトコードの逆アセンブル文字列を取得する
 * @param tmpl テンプレート文字列
 * @return 逆アセンブル結果。エラー時は空文字
 */
std::string do_compile_disasm(std::string_view tmpl) {
  injamm::engine<Dummy> eng(tmpl);
  auto const& bc = eng.get_bytecode();
  if (bc.error.ec != injamm::error_code::none) return "";
  return bc.disassemble();
}

/**
 * @brief バイトコードから C++ レンダリングヘッダを生成する
 * @param tmpl テンプレート文字列
 * @param typeName 生成するデータ型名（例: MyData）
 * @return 生成された render.hpp の内容。エラー時は空文字
 * @details 一度 save_bytecode でバイナリ化し、reader で再パースして code_generator に渡す。
 *          これは WASM 側のバイナリパーサ（codegen.hpp）が正しく動作することを保証するための経路。
 */
std::string do_codegen(std::string_view tmpl, std::string_view typeName) {
  injamm::engine<Dummy> eng(tmpl);
  auto const& real_bc = eng.get_bytecode();
  if (real_bc.error.ec != injamm::error_code::none) return "";
  std::string tn{typeName};
  if (tn.empty()) tn = "Data"; // 型名が空なら既定値を使用
  std::ostringstream oss(std::ios::binary);
  auto ec = injamm::save_bytecode(real_bc, oss);
  if (ec != injamm::error_code::none) return "";
  std::string bin = oss.str();
  reader r(bin.data(), bin.size()); // WASM 側のバイナリパーサ
  auto bc_opt = r.read_bytecode();
  if (!bc_opt) return "";
  code_generator gen(tn, "generated", "", false);
  return gen.generate(*bc_opt);
}

/**
 * @brief テンプレート内の変数参照情報を JSON 配列で取得する
 * @param tmpl テンプレート文字列
 * @return JSON 配列文字列（各要素は key/has_dot/is_section/filters 等）
 * @details エラー時でも収集済みの var_ref を可能な限り返す。
 *          命令列を走査して is_section / is_inverted / is_if / is_inside / parent_section を付与する。
 */
std::string do_analyze_json(std::string_view tmpl) {
  injamm::engine<Dummy> eng(tmpl);
  auto const& bc = eng.get_bytecode();
  // ----- セクション・条件分岐の判定用フラグ -----
  std::vector<char> is_section(bc.var_refs.size(), 0); // emit_section で参照された var_ref
  std::vector<char> is_inverted(bc.var_refs.size(), 0); // emit_inverted で参照された var_ref
  std::vector<char> is_if(bc.var_refs.size(), 0); // 各種 emit_if 系で参照された var_ref
  for (auto const& inst : bc.instructions) {
    using op = injamm::detail::bc_opcode;
    if (inst.op == op::emit_section && inst.operand2 < is_section.size()) is_section[inst.operand2] = 1;
    if (inst.op == op::emit_inverted && inst.operand2 < is_inverted.size()) is_inverted[inst.operand2] = 1;
    if ((inst.op == op::emit_if || inst.op == op::emit_if_eq || inst.op == op::emit_if_ne ||
         inst.op == op::emit_if_gt || inst.op == op::emit_if_gte || inst.op == op::emit_if_lt ||
         inst.op == op::emit_if_lte || inst.op == op::emit_if_or || inst.op == op::emit_if_and ||
         inst.op == op::emit_if_not || inst.op == op::emit_if_filtered) && inst.operand2 < is_if.size())
      is_if[inst.operand2] = 1;
  }
  // ----- セクション内部かどうかの判定（スタックで追跡） -----
  std::vector<char> is_inside(bc.var_refs.size(), 0); // セクション内部で参照されたか
  std::vector<std::string> parent_for_var(bc.var_refs.size(), ""); // 親セクション名
  {
    using op = injamm::detail::bc_opcode;
    std::vector<std::string> stack; // 現在のセクションネスト
    for (auto const& inst : bc.instructions) {
      if (inst.op == op::emit_section || inst.op == op::emit_inverted) {
        if (inst.operand2 < bc.var_refs.size()) stack.push_back(bc.var_refs[inst.operand2].key);
        else stack.push_back("");
        continue;
      }
      if (inst.op == op::emit_end) {
        if (!stack.empty()) stack.pop_back();
        continue;
      }
      int varIdx = -1; // 変数参照インデックス
      switch (inst.op) {
        case op::emit_var:
        case op::emit_var_raw:
        case op::emit_var_size:
          varIdx = (int)inst.operand;
          break;
        case op::emit_litvar:
        case op::emit_litvar_raw:
          varIdx = (int)inst.operand2;
          break;
        case op::resolve_filtered:
        case op::emit_if:
        case op::emit_if_eq:
        case op::emit_if_ne:
        case op::emit_if_gt:
        case op::emit_if_gte:
        case op::emit_if_lt:
        case op::emit_if_lte:
        case op::emit_if_or:
        case op::emit_if_and:
        case op::emit_if_not:
        case op::emit_if_filtered:
          varIdx = (int)inst.operand2;
          break;
        default: break;
      }
      // セクション自身でなく、かつスタックが空でなければセクション内部とみなす
      if (varIdx >= 0 && varIdx < (int)bc.var_refs.size() && !is_section[varIdx] && !is_inverted[varIdx] && !stack.empty()) {
        is_inside[varIdx] = 1;
        parent_for_var[varIdx] = stack.back();
      }
    }
  }
  // ----- JSON 配列の構築 -----
  std::string j = "[";
  for (std::size_t i = 0; i < bc.var_refs.size(); ++i) {
    auto const& r = bc.var_refs[i];
    if (i) j += ",";
    j += "{";
    j += "\"key\":\"" + json_escape(r.key) + "\"";
    j += ",\"has_dot\":" + std::string(r.has_dot ? "true" : "false");
    j += ",\"is_loop_parent\":" + std::string(r.is_loop_parent ? "true" : "false");
    j += ",\"is_section\":" + std::string(is_section[i] ? "true" : "false");
    j += ",\"is_inverted\":" + std::string(is_inverted[i] ? "true" : "false");
    j += ",\"is_if\":" + std::string(is_if[i] ? "true" : "false");
    j += ",\"filter_flags\":" + std::to_string((int)r.filter_flags);
    j += ",\"section_op_count\":" + std::to_string((int)r.section_op_count);
    // 比較右辺の情報
    j += ",\"compare_rhs_kind\":" + std::to_string((int)r.compare_rhs_kind);
    j += ",\"compare_rhs_text\":\"" + json_escape(r.compare_rhs_text) + "\"";
    j += ",\"compare_rhs_has_dot\":" + std::string(r.compare_rhs_has_dot ? "true" : "false");
    // フィルタ配列（文字列フィルタ名を列挙）
    j += ",\"filters\":[";
    for (size_t fi = 0; fi < r.filters.size(); ++fi) {
      if (fi) j += ",";
      auto name = injamm::detail::string_filter_name(r.filters[fi].filter);
      j += "\"" + std::string(name) + "\"";
    }
    j += "]";
    j += ",\"int_filters\":[";
    for (size_t fi = 0; fi < r.int_filters.size(); ++fi) {
      if (fi) j += ",";
      auto name = injamm::detail::int_filter_name(r.int_filters[fi].filter);
      j += "\"" + std::string(name) + "\"";
    }
    j += "]";
    j += ",\"float_filters\":[";
    for (size_t fi = 0; fi < r.float_filters.size(); ++fi) {
      if (fi) j += ",";
      auto name = injamm::detail::float_filter_name(r.float_filters[fi].filter);
      j += "\"" + std::string(name) + "\"";
    }
    j += "]";
    // ループ関連の特殊変数か（フロントエンドで構造体生成から除外）
    bool is_loop = r.key.rfind("loop.", 0) == 0 || r.key == "this" || r.key == ".";
    j += ",\"is_loop_var\":" + std::string(is_loop ? "true" : "false");
    // safe フィルタ（生出力）の有無
    bool has_safe = false;
    for (auto const& f : r.filters) if (f.filter == injamm::detail::string_filter::safe) has_safe = true;
    j += ",\"has_safe\":" + std::string(has_safe ? "true" : "false");
    j += ",\"is_inside\":" + std::string(is_inside[i] ? "true" : "false");
    j += ",\"parent_section\":\"" + json_escape(parent_for_var[i]) + "\"";
    j += "}";
  }
  j += "]";
  return j;
}

} // namespace

#ifdef __EMSCRIPTEN__
/**
 * @brief Emscripten 向けエクスポート関数群
 * @details JavaScript から直接呼び出せるように std::string ベースのラッパを提供する。
 */
std::string validate(std::string tmpl) { return make_validate_json(tmpl); } /**< @brief 検証（JSON 文字列を返す） */
std::string compile_disasm(std::string tmpl) { return do_compile_disasm(tmpl); } /**< @brief 逆アセンブルを取得 */
std::string codegen(std::string tmpl, std::string typeName) { return do_codegen(tmpl, typeName); } /**< @brief C++ ヘッダを生成 */
std::string analyze_json(std::string tmpl) { return do_analyze_json(tmpl); } /**< @brief 変数解析結果を JSON で取得 */

/**
 * @brief バイトコードを Uint8Array として返す（Emscripten 用）
 * @param tmpl テンプレート文字列
 * @return Uint8Array（JS 側で所有）。失敗時は空の Uint8Array
 */
emscripten::val compile_bytes(std::string tmpl) {
  auto bytes = do_compile_bytes(tmpl);
  if (bytes.empty()) {
    // 失敗時は空の Uint8Array を返す
    return emscripten::val::global("Uint8Array").new_(0);
  }
  // typed_memory_view から JS 側へコピー
  auto view = emscripten::val(emscripten::typed_memory_view(bytes.size(), bytes.data()));
  auto arr = emscripten::val::global("Uint8Array").new_(view);
  return arr;
}

/** @brief Emscripten バインディング定義 */
EMSCRIPTEN_BINDINGS(injamm_wasm) {
  emscripten::function("validate", &validate);
  emscripten::function("compile_bytes", &compile_bytes);
  emscripten::function("compile_disasm", &compile_disasm);
  emscripten::function("codegen", &codegen);
  emscripten::function("analyze_json", &analyze_json);
}
#else
// ----- ネイティブビルド（テスト用）: Emscripten なしでも同じロジックを呼び出せる -----
std::string validate(std::string tmpl) { return make_validate_json(tmpl); } /**< @brief 検証（ネイティブ） */
std::string compile_disasm(std::string tmpl) { return do_compile_disasm(tmpl); } /**< @brief 逆アセンブル（ネイティブ） */
std::string codegen(std::string tmpl, std::string typeName) { return do_codegen(tmpl, typeName); } /**< @brief コード生成（ネイティブ） */
std::string analyze_json(std::string tmpl) { return do_analyze_json(tmpl); } /**< @brief 解析（ネイティブ） */
std::vector<uint8_t> compile_bytes(std::string tmpl) { return do_compile_bytes(tmpl); } /**< @brief バイトコード取得（ネイティブ） */
#endif
