/**
 * @file structGen.js
 * @brief var_refs（WASM 解析結果）から C++ 構造体定義と glz::meta を生成する
 * @details wasm の analyze_json が返す is_inside / parent_section 情報を利用して、
 *          ネストされたフィールドを正しい親構造体配下に配置する。
 */

// 文字列フィルタ名の一覧（型推論で string と判定するための集合）
const STRING_FILTERS = new Set(["upper","lower","capitalize","title","trim","ltrim","rtrim","strip","lstrip","rstrip","left","right","center","truncate","substr","replace","urlencode","default","safe","json","indent","pad","pluralize","repeat","format"]);
// 整数フィルタ名の一覧（型推論で int と判定するための集合）
const INT_FILTERS = new Set(["abs","neg","hex","oct","bin","mod","numify","zerofill","is_neg","eq","ne","gt","gte","lt","lte","add","sub","mul","div"]);

/**
 * @brief int フィルタが含まれているか判定する
 * @param {Array<string>} filters 文字列フィルタ配列（未使用だが互換のため保持）
 * @param {Array<string>} intFilters 整数フィルタ配列
 * @return {boolean} 整数フィルタが1つでも含まれれば true
 */
function isIntFilter(filters, intFilters) {
  for (const f of intFilters || []) if (INT_FILTERS.has(f)) return true;
  return false;
}

/**
 * @brief string フィルタが含まれているか判定する
 * @param {Array<string>} filters フィルタ名配列
 * @return {boolean} 文字列フィルタが1つでも含まれれば true
 */
function isStringFilter(filters) {
  for (const f of filters || []) if (STRING_FILTERS.has(f)) return true;
  return false;
}

/**
 * @brief var_ref から C++ の型を推論する
 * @param {Object} r var_ref オブジェクト（filters/int_filters/compare_rhs_kind 等）
 * @return {string} "string" または "int"
 * @details int_filters があれば int、string フィルタがあれば string、比較右辺が数値なら int とする。
 *          浮動小数点は現状 string に倒す（将来的に float 対応が必要なら拡張）。
 */
function inferType(r) {
  let t = "string";
  if (r.int_filters && r.int_filters.length > 0) t = "int";
  else if (r.filters && r.filters.length > 0) {
    if (isStringFilter(r.filters)) t = "string";
    else if (isIntFilter(r.filters, r.int_filters)) t = "int";
  }
  if (r.compare_rhs_kind === 1) t = "int";    // 比較右辺が数値リテラル
  if (r.compare_rhs_kind === 2) t = "string"; // 比較右辺が文字列リテラル
  // float は現状 string として扱う（明示的な float フィルタがあれば拡張）
  return t;
}

/**
 * @brief var_ref 配列から C++ 構造体定義を生成する
 * @param {Array<Object>} varRefs WASM の analyze_json が返す var_ref 配列
 * @param {string} typeName 生成するルート構造体名（既定 "Data"）
 * @return {string} C++ 構造体定義と glz::meta 特殊化を含むソースコード
 * @details ルート・ネスト構造体・配列（vector）・セクション要素型を再帰的に構築し、
 *          glaze のリフレクション用メタ情報を付与する。
 */
export function generateStruct(varRefs, typeName = "Data") {
  // 空入力の場合は空の構造体を返す
  if (!varRefs || varRefs.length === 0) {
    return `struct ${typeName} {};\ntemplate <> struct glz::meta<${typeName}> { static constexpr auto value = glz::object(); };`;
  }
  // ループ変数（loop.* / this / . / root）はフィールドから除外
  const refs = varRefs.filter(r => !r.is_loop_var && r.key && !r.key.startsWith("loop.") && r.key !== "this" && r.key !== "." && r.key !== "root");
  if (refs.length === 0) {
    return `struct ${typeName} {};\ntemplate <> struct glz::meta<${typeName}> { static constexpr auto value = glz::object(); };`;
  }

  // ルートノード（最上位の構造体）
  const root = { fields: new Map(), name: typeName };
  // セクション（{{#users}} 等）の要素型ノード: セクションキー -> 要素ノード
  const sectionNodes = new Map(); // full section key -> element node {fields: Map, name, vectorRef}

  /**
   * @brief ネスト構造体を保証して取得する
   * @param {Object} node 親ノード
   * @param {string} part フィールド名の1要素
   * @return {Object} 対応する子ノード
   * @details vector の要素配下へのアクセスや、スカラーから構造体への昇格も扱う。
   */
  function ensureStruct(node, part) {
    if (!node.fields.has(part)) {
      node.fields.set(part, { kind: "struct", fields: new Map(), name: part });
    }
    let nxt = node.fields.get(part);
    if (nxt.kind === "vector") {
      // vector 要素配下へのネスト（例: users.profile.name）
      if (!nxt.fields) nxt.fields = new Map();
      return { fields: nxt.fields, name: nxt.elemName, _isVectorElement: true, _vectorRef: nxt };
    }
    if (nxt.kind !== "struct") {
      // スカラーが後からネストの親になった場合は構造体へ変換（稀なケース）
      nxt.kind = "struct";
      nxt.fields = new Map();
    }
    return nxt;
  }

  // ----- var_ref を走査してフィールドツリーを構築 -----
  for (const r of refs) {
    const isSection = !!(r.is_section || r.is_inverted); // セクション（配列）か
    const isInside = !!r.is_inside; // セクション内部の変数か
    const parent = r.parent_section || ""; // 親セクション名

    // 配置先ノードの決定: セクション内部なら親セクションの要素型配下、そうでなければルート
    let targetNode;
    if (isInside && parent && sectionNodes.has(parent)) {
      targetNode = sectionNodes.get(parent);
    } else if (isInside && parent) {
      // 親セクションが未登録の場合のフォールバック（通常はセクションが先に出現するため稀）
      const p = parent.split(".").pop(); // 親名の末尾要素
      // ルート直下の vector を末尾名で探す
      let found = null;
      for (const [, v] of root.fields) if (v.kind === "vector" && v._origKey === parent) found = v;
      if (found) targetNode = { fields: found.fields, name: found.elemName };
      else targetNode = root;
    } else {
      targetNode = root;
    }

    // root. プレフィックスの除去
    let key = r.key;
    if (key.startsWith("root.")) key = key.slice(5);
    if (key === "root") continue;
    const parts = key.split("."); // ドット区切りでネストを分解
    const inferred = inferType(r); // 型推論

    if (isSection) {
      // セクション: 親ノード配下に vector を生成
      let cur = targetNode;
      for (let i = 0; i < parts.length - 1; i++) {
        cur = ensureStruct(cur, parts[i]);
      }
      const last = parts[parts.length - 1];
      if (!cur.fields.has(last)) {
        const elemName = last.charAt(0).toUpperCase() + last.slice(1) + "Item"; // 要素型名（例: UsersItem）
        const vec = { kind: "vector", elemName, fields: new Map(), _origKey: r.key };
        cur.fields.set(last, vec);
        // 子フィールド配置用に要素ノードを登録
        sectionNodes.set(r.key, { fields: vec.fields, name: elemName, _vectorRef: vec });
      } else {
        const existing = cur.fields.get(last);
        if (existing.kind !== "vector") {
          const elemName = last.charAt(0).toUpperCase() + last.slice(1) + "Item";
          existing.kind = "vector";
          existing.elemName = elemName;
          if (!existing.fields) existing.fields = new Map();
          sectionNodes.set(r.key, { fields: existing.fields, name: elemName, _vectorRef: existing });
        } else {
          // 既に vector として存在する場合はマッピングを保証
          if (!sectionNodes.has(r.key)) {
            sectionNodes.set(r.key, { fields: existing.fields, name: existing.elemName, _vectorRef: existing });
          }
        }
      }
    } else {
      // 通常フィールド: ネストを辿って末尾に配置
      let cur = targetNode;
      for (let i = 0; i < parts.length - 1; i++) {
        cur = ensureStruct(cur, parts[i]);
      }
      const last = parts[parts.length - 1];
      if (!cur.fields.has(last)) {
        cur.fields.set(last, { kind: inferred, fields: null });
      } else {
        // 既存が vector なら維持、スカラー同士の型衝突は最初の定義を優先
      }
    }
  }

  // ----- C++ コード生成（再帰的に構造体を出力） -----
  const structs = [];
  /**
   * @brief 1つの構造体ノードを C++ コードへ変換する（再帰）
   * @param {Object} node 構造体ノード
   * @param {string} structName 出力する構造体名
   */
  function emitStruct(node, structName) {
    // 先にネストされた構造体/要素型を再帰的に出力（前方宣言不要にするため）
    for (const [fname, f] of node.fields) {
      if (f.kind === "struct") {
        const nestedName = structName + "_" + fname.charAt(0).toUpperCase() + fname.slice(1);
        emitStruct(f, nestedName);
        f.emitName = nestedName;
      } else if (f.kind === "vector") {
        if (f.fields && f.fields.size > 0) {
          const elemName = structName + "_" + fname.charAt(0).toUpperCase() + fname.slice(1) + "Item";
          const elemNode = { fields: f.fields, name: elemName };
          emitStruct(elemNode, elemName);
          f.elemEmitName = elemName;
        }
      }
    }
    let code = `struct ${structName} {\n`;
    for (const [fname, f] of node.fields) {
      let typ;
      if (f.kind === "vector") {
        if (f.elemEmitName) typ = `std::vector<${f.elemEmitName}>`;
        else if (f.fields && f.fields.size > 0) typ = `std::vector<std::string>`;
        else typ = `std::vector<std::string>`;
        // {{#users}}{{this}} のようなケースは要素が string の vector として扱う
      } else if (f.kind === "struct") {
        typ = f.emitName;
      } else if (f.kind === "int") {
        typ = "int";
      } else {
        typ = "std::string";
      }
      code += `  ${typ} ${fname}{};\n`;
    }
    code += `};\n`;
    // glaze 用メタ情報: フィールド名とメンバポインタの対応
    code += `template <> struct glz::meta<${structName}> {\n  static constexpr auto value = glz::object(\n`;
    const entries = [];
    for (const [fname] of node.fields) entries.push(`    "${fname}", &${structName}::${fname}`);
    code += entries.join(",\n");
    if (entries.length) code += "\n";
    code += `  );\n};\n`;
    structs.push(code);
  }

  emitStruct(root, typeName);
  // 子構造体が先に定義されるように逆順で連結
  return structs.reverse().join("\n");
}
