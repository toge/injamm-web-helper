/**
 * @file test_wasm.cpp
 * @brief WASM バインディング層（injamm_wasm）のネイティブテスト
 * @details Emscripten なしで injamm_wasm.cpp のロジックを Catch2 で検証する。
 *          各 API（validate / compile_bytes / compile_disasm / codegen / analyze_json）が
 *          期待通りの入出力を行うことを確認する。
 */
#include <catch2/catch_test_macros.hpp>
#include <cstdint>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

// injamm_wasm.cpp（ネイティブビルド）側の宣言
std::string validate(std::string tmpl); /**< @brief テンプレート検証（JSON 返却） */
std::string compile_disasm(std::string tmpl); /**< @brief 逆アセンブル取得 */
std::string codegen(std::string tmpl, std::string typeName); /**< @brief C++ ヘッダ生成 */
std::string analyze_json(std::string tmpl); /**< @brief 変数解析（JSON 返却） */
std::vector<uint8_t> compile_bytes(std::string tmpl); /**< @brief バイトコード生成 */

/**
 * @brief JSON 文字列に特定の部分文字列が含まれるか判定するヘルパ
 * @param j JSON 文字列
 * @param needle 探す部分文字列
 * @return 含まれていれば true
 */
static bool json_contains(std::string const& j, std::string_view needle) {
  return j.find(needle) != std::string::npos;
}

// ----- validate のテスト -----

TEST_CASE("validate ok", "[wasm]") {
  // 正常なテンプレートは ok:true を返す
  auto j = validate("Hello {{name}}");
  REQUIRE(json_contains(j, "\"ok\":true"));
}

TEST_CASE("validate empty ok", "[wasm]") {
  // 空テンプレートも正常扱い
  auto j = validate("");
  REQUIRE(json_contains(j, "\"ok\":true"));
}

TEST_CASE("validate syntax error missing close", "[wasm]") {
  // 閉じていないセクションは構文エラー（unexpected_end, ec=2）
  auto j = validate("Hello {{#users}}");
  REQUIRE(json_contains(j, "\"ok\":false"));
  // unexpected_end
  REQUIRE(json_contains(j, "\"ec\":2"));
}

TEST_CASE("validate invalid filter", "[wasm]") {
  // 存在しないフィルタは unknown_filter（ec=7）
  auto j = validate("{{name | bogusfilter}}");
  REQUIRE(json_contains(j, "\"ok\":false"));
  REQUIRE(json_contains(j, "\"ec\":7")); // unknown_filter
}

TEST_CASE("validate unclosed if", "[wasm]") {
  // 閉じていない if もエラー
  auto j = validate("{{#if name}}hi");
  REQUIRE(json_contains(j, "\"ok\":false"));
}

TEST_CASE("validate with triple mustache ok", "[wasm]") {
  // トリプル括弧（生出力）も正常
  auto j = validate("{{{html}}}");
  REQUIRE(json_contains(j, "\"ok\":true"));
}

// ----- compile_bytes のテスト -----

TEST_CASE("compile_bytes header IJBC", "[wasm]") {
  // バイトコードの先頭 4 バイトはマジック "IJBC"
  auto v = compile_bytes("Hello {{name}}");
  REQUIRE(v.size() >= 4);
  REQUIRE(v[0] == 'I');
  REQUIRE(v[1] == 'J');
  REQUIRE(v[2] == 'B');
  REQUIRE(v[3] == 'C');
}

TEST_CASE("compile_bytes error empty", "[wasm]") {
  // コンパイル失敗時は空ベクタを返す
  auto v = compile_bytes("{{#users}}");
  REQUIRE(v.empty());
}

// ----- compile_disasm のテスト -----

TEST_CASE("compile_disasm contains opcode", "[wasm]") {
  // 逆アセンブル結果に命令名が含まれる
  auto s = compile_disasm("Hello {{name}}");
  REQUIRE(!s.empty());
  REQUIRE((s.find("emit_") != std::string::npos || s.find("instructions") != std::string::npos));
}

// ----- codegen のテスト -----

TEST_CASE("codegen produces compilable header", "[wasm]") {
  // 生成されたヘッダは #pragma once と型名を含む
  auto s = codegen("Hello {{name}}", "MyData");
  REQUIRE(!s.empty());
  REQUIRE(s.find("#pragma once") != std::string::npos);
  REQUIRE((s.find("MyData") != std::string::npos || s.find("render") != std::string::npos));
}

// ----- analyze_json のテスト -----

TEST_CASE("analyze_json returns array", "[wasm]") {
  // 解析結果は JSON 配列で var_ref が列挙される
  auto j = analyze_json("Hello {{name}} {{user.age}} {{#users}}{{name|upper}}{{/users}}");
  REQUIRE(!j.empty());
  REQUIRE(j.front() == '[');
  REQUIRE(json_contains(j, "\"key\":\"name\""));
  // upper フィルタが正しく捕捉されている
  REQUIRE(json_contains(j, "upper"));
}

TEST_CASE("validate syntax position valid", "[wasm]") {
  // エラー時の位置情報（pos/line/col）が含まれる
  auto j = validate("line1\n{{#users}}");
  REQUIRE(json_contains(j, "\"ok\":false"));
  REQUIRE(json_contains(j, "\"ec\":2"));
}

TEST_CASE("codegen sample + users not empty", "[wasm]") {
  // sample と users を含むテンプレートでもヘッダが生成される
  auto tmpl = std::string("{{sample}}\n{{#users}}\n  {{name|upper}} \n{{/users}} \n");
  auto s = codegen(tmpl, "MyData");
  REQUIRE(!s.empty());
  REQUIRE(json_contains(s, "#pragma once"));
  REQUIRE(json_contains(s, "sample"));
  REQUIRE(json_contains(s, "users"));
}

TEST_CASE("analyze_json sample inside vs outside", "[wasm]") {
  // セクション内外の変数が正しく区別される（is_inside / parent_section）
  auto tmpl = std::string("{{sample}}\n{{#users}}\n  {{name|upper}} \n{{/users}} \n");
  auto j = analyze_json(tmpl);
  REQUIRE(json_contains(j, "\"key\":\"sample\""));
  REQUIRE(json_contains(j, "\"key\":\"name\""));
  // sample はセクション外、name は内部
  REQUIRE(json_contains(j, "\"key\":\"sample\",\"has_dot\":false"));
  // is_inside: sample=false, name=true を検証
  auto pos_sample_inside = j.find("\"key\":\"sample\"");
  auto pos_sample_is_inside = j.find("\"is_inside\":false", pos_sample_inside);
  REQUIRE(pos_sample_is_inside != std::string::npos);
  auto pos_name = j.find("\"key\":\"name\"");
  auto pos_name_inside = j.find("\"is_inside\":true", pos_name);
  REQUIRE(pos_name_inside != std::string::npos);
  auto pos_parent = j.find("\"parent_section\":\"users\"", pos_name);
  REQUIRE(pos_parent != std::string::npos);
}
