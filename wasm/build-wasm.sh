#!/bin/sh
# injamm WASM ビルドスクリプト (cmake ベース)
# cmake + vcpkg (wasm32-emscripten triplet) + Emscripten で frontend/public/injamm.js(.wasm) を生成する
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$SCRIPT_DIR/.."
FRONTEND_PUBLIC="$REPO_ROOT/frontend/public"
BUILD_DIR="$REPO_ROOT/build-wasm"

# VCPKG_ROOT の解決: 環境変数 > $HOME/vm/vcpkg > ./vcpkg > VCPKG_INSTALLATION_ROOT
VCPKG_ROOT="${VCPKG_ROOT:-}"
if [ -z "$VCPKG_ROOT" ]; then
  if [ -n "${HOME:-}" ] && [ -f "$HOME/vm/vcpkg/scripts/buildsystems/vcpkg.cmake" ]; then
    VCPKG_ROOT="$HOME/vm/vcpkg"
  elif [ -f "$REPO_ROOT/vcpkg/scripts/buildsystems/vcpkg.cmake" ]; then
    VCPKG_ROOT="$REPO_ROOT/vcpkg"
  elif [ -n "${VCPKG_INSTALLATION_ROOT:-}" ] && [ -f "$VCPKG_INSTALLATION_ROOT/scripts/buildsystems/vcpkg.cmake" ]; then
    VCPKG_ROOT="$VCPKG_INSTALLATION_ROOT"
  fi
fi

# EMSDK の解決: 環境変数 > ./emsdk > $HOME/vm/emsdk > emcc のパスから推定
EMSDK="${EMSDK:-}"
if [ -z "$EMSDK" ]; then
  if [ -d "$REPO_ROOT/emsdk" ]; then
    EMSDK="$REPO_ROOT/emsdk"
  elif [ -n "${HOME:-}" ] && [ -d "$HOME/vm/emsdk" ]; then
    EMSDK="$HOME/vm/emsdk"
  fi
fi
if [ -z "$EMSDK" ] && command -v emcc >/dev/null 2>&1; then
  _emcc_path="$(command -v emcc)"
  EMSDK="$(cd "$(dirname "$_emcc_path")/.." && pwd)"
  # emcc が upstream/emscripten/emcc の場合は 2 階層上
  if [ ! -f "$EMSDK/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake" ] && [ -f "$(dirname "$EMSDK")/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake" ]; then
    EMSDK="$(cd "$EMSDK/.." && pwd)"
  fi
fi
if [ -n "${EMSDK:-}" ] && [ -f "$EMSDK/emsdk_env.sh" ] && [ -z "${EMSDK_ENV_SOURCED:-}" ]; then
  # emsdk_env.sh があれば PATH を補完 (CI で emsdk を clone した直後など)
  . "$EMSDK/emsdk_env.sh" >/dev/null 2>&1 || true
fi

if [ -z "$VCPKG_ROOT" ] || [ ! -f "$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake" ]; then
  echo "error: VCPKG_ROOT not found (tried \$VCPKG_ROOT, \$HOME/vm/vcpkg, ./vcpkg, \$VCPKG_INSTALLATION_ROOT)" >&2
  exit 1
fi
if [ -z "$EMSDK" ] || [ ! -f "$EMSDK/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake" ]; then
  echo "error: EMSDK not found (tried \$EMSDK, ./emsdk, \$HOME/vm/emsdk, emcc in PATH)" >&2
  echo "  install: git clone https://github.com/emscripten-core/emsdk.git && ./emsdk/emsdk install latest && ./emsdk/emsdk activate latest" >&2
  exit 1
fi

mkdir -p "$FRONTEND_PUBLIC"

echo "Configuring WASM build (VCPKG_ROOT=$VCPKG_ROOT, EMSDK=$EMSDK) ..."
cmake -B "$BUILD_DIR" -S "$REPO_ROOT" \
  -DCMAKE_TOOLCHAIN_FILE="$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake" \
  -DVCPKG_TARGET_TRIPLET=wasm32-emscripten \
  -DVCPKG_CHAINLOAD_TOOLCHAIN_FILE="$EMSDK/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake" \
  -DCMAKE_BUILD_TYPE=Release

echo "Building injamm.wasm -> $FRONTEND_PUBLIC/injamm.js"
cmake --build "$BUILD_DIR" --parallel "$(nproc 2>/dev/null || echo 4)"

echo "wasm size: $(du -h "$FRONTEND_PUBLIC/injamm.wasm" 2>/dev/null || echo 'unknown')"
echo "js size: $(du -h "$FRONTEND_PUBLIC/injamm.js" 2>/dev/null || echo 'unknown')"

DIST_DIR="$REPO_ROOT/dist"
if [ -d "$DIST_DIR" ]; then
  cp -v "$FRONTEND_PUBLIC/injamm.js" "$DIST_DIR/"
  cp -v "$FRONTEND_PUBLIC/injamm.wasm" "$DIST_DIR/"
fi
