cmake_minimum_required(VERSION 3.25)

# standalone でも add_subdirectory でも動作するようガード
if(CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR)
  project(injamm_wasm LANGUAGES CXX)
  set(CMAKE_CXX_STANDARD 23)
  set(CMAKE_CXX_STANDARD_REQUIRED ON)
  set(CMAKE_CXX_EXTENSIONS OFF)
  set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
endif()

find_package(injamm CONFIG REQUIRED)

if(EMSCRIPTEN)
  # WASM 本体: frontend/public/injamm.js(+.wasm) を生成
  add_executable(injamm_wasm injamm_wasm.cpp)
  target_link_libraries(injamm_wasm PRIVATE injamm::injamm)
  target_compile_features(injamm_wasm PRIVATE cxx_std_23)
  target_link_options(injamm_wasm PRIVATE
    -O3
    -sNO_DISABLE_EXCEPTION_CATCHING
    -sALLOW_MEMORY_GROWTH=1
    -lembind
    "SHELL:-sEXPORTED_RUNTIME_METHODS=['ccall','cwrap']"
    -sWASM=1
    -sENVIRONMENT=web
    -sMODULARIZE=1
    "SHELL:-sEXPORT_NAME=createInjammModule"
  )
  set_target_properties(injamm_wasm PROPERTIES
    OUTPUT_NAME "injamm"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/../frontend/public"
  )
else()
  find_package(Catch2 REQUIRED CONFIG)
  enable_testing()
  add_executable(test_wasm tests/test_wasm.cpp injamm_wasm.cpp)
  target_link_libraries(test_wasm PRIVATE injamm::injamm Catch2::Catch2WithMain)
  target_compile_features(test_wasm PRIVATE cxx_std_23)
  add_test(NAME test_wasm COMMAND test_wasm --reporter junit)
endif()
