/**
 * @file structGen.test.js
 * @brief structGen のユニットテスト
 * @details var_ref から C++ 構造体が正しく推論されるかを検証する。
 *          ネスト、配列、フィルタ、セクション内外の配置などをカバーする。
 */
import { describe, it, expect } from "vitest";
import { generateStruct } from "./structGen.js";

describe("structGen", () => {
  it("a.b nested", () => {
    // ドット区切りパスのネスト: a.b は a 構造体配下の b フィールドとして生成される
    const refs = [
      { key: "a.b", has_dot: true, is_section: false, is_loop_var: false, filters: [], int_filters: [], compare_rhs_kind: 0 },
    ];
    const out = generateStruct(refs, "Data");
    expect(out).toContain("struct Data");
    expect(out).toContain("a");
    expect(out).toContain("glz::meta");
  });

  it("#users array", () => {
    // セクション: #users は vector、is_inside の name は要素型配下に配置される
    const refs = [
      { key: "users", has_dot: false, is_section: true, is_loop_var: false, filters: [], int_filters: [], compare_rhs_kind: 0 },
      { key: "name", has_dot: false, is_section: false, is_loop_var: false, filters: [], int_filters: [], compare_rhs_kind: 0 },
    ];
    const out = generateStruct(refs, "Data");
    expect(out).toContain("vector");
    expect(out).toContain("users");
  });

  it("| upper -> string", () => {
    // 上限変換フィルタは文字列型として推論される
    const refs = [
      { key: "name", has_dot: false, is_section: false, is_loop_var: false, filters: ["upper"], int_filters: [], compare_rhs_kind: 0 },
    ];
    const out = generateStruct(refs, "Data");
    expect(out).toContain("std::string name");
  });

  it("age==3 -> int", () => {
    // 比較右辺が数値なら int 型として推論される
    const refs = [
      { key: "age", has_dot: false, is_section: false, is_loop_var: false, filters: [], int_filters: [], compare_rhs_kind: 1, compare_rhs_text: "3" },
    ];
    const out = generateStruct(refs, "Data");
    expect(out).toContain("int age");
  });

  it("empty input", () => {
    // 空入力は空の構造体を返す
    const out = generateStruct([], "Data");
    expect(out).toContain("struct Data {}");
  });

  it("sample + users/name correctly nested", () => {
    // sample はルート、name は users セクション内部に正しく分離されることを検証
    const refs = [
      { key: "sample", has_dot: false, is_section: false, is_loop_var: false, filters: [], int_filters: [], compare_rhs_kind: 0, is_inside: false, parent_section: "" },
      { key: "users", has_dot: false, is_section: true, is_loop_var: false, filters: [], int_filters: [], compare_rhs_kind: 0, is_inside: false, parent_section: "" },
      { key: "name", has_dot: false, is_section: false, is_loop_var: false, filters: ["upper"], int_filters: [], compare_rhs_kind: 0, is_inside: true, parent_section: "users" },
    ];
    const out = generateStruct(refs, "MyData");
    // sample は MyData 直下に配置される
    expect(out).toContain("std::string sample");
    expect(out).toContain("std::vector<MyData_UsersItem> users");
    expect(out).toContain("struct MyData_UsersItem");
    // name は UsersItem 内部、MyData 直下には含まれない
    const myDataPart = out.split("struct MyData_UsersItem")[0];
    expect(myDataPart).toContain("sample");
    expect(myDataPart).not.toContain("std::string name");
    const usersItemPart = out.split("struct MyData_UsersItem")[1];
    expect(usersItemPart).toContain("std::string name");
    expect(usersItemPart).not.toContain("sample");
  });
});
