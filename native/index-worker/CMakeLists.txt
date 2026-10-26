# Copyright 2026 Frank Gao
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

cmake_minimum_required(VERSION 3.28)
project(rtl_index_worker LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(MSVC OR (CMAKE_CXX_COMPILER_ID STREQUAL "Clang" AND
            CMAKE_CXX_COMPILER_FRONTEND_VARIANT STREQUAL "MSVC"))
  set(RTL_MSVC_LIKE TRUE)
  # The release workspace is self-contained: keep the MSVC runtime and the
  # slang static library on the same static CRT.
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

if(NOT RTL_DEPS_DIR)
  if(DEFINED ENV{RTL_DEPS_DIR})
    set(RTL_DEPS_DIR "$ENV{RTL_DEPS_DIR}")
  else()
    set(RTL_DEPS_DIR "/work/.sandbox/deps")
  endif()
endif()
set(RTL_SLANG_COMMIT "unknown" CACHE STRING "Pinned slang commit recorded in snapshots")

set(SQLITE_DIR "${RTL_DEPS_DIR}/sqlite")
set(SLANG_PREFIX "${RTL_DEPS_DIR}/slang")
list(APPEND CMAKE_PREFIX_PATH
  "${SLANG_PREFIX}"
  "${SLANG_PREFIX}/lib64/cmake/slang"
  "${SLANG_PREFIX}/lib/cmake/slang")
find_package(slang CONFIG REQUIRED)
find_package(Threads REQUIRED)

add_library(rtl_sqlite3 STATIC "${SQLITE_DIR}/sqlite3.c")
target_include_directories(rtl_sqlite3 PUBLIC "${SQLITE_DIR}")
target_compile_definitions(rtl_sqlite3 PRIVATE
  SQLITE_THREADSAFE=0
  SQLITE_OMIT_LOAD_EXTENSION
  SQLITE_DQS=0
  SQLITE_DEFAULT_MEMSTATUS=0)

add_executable(index-worker
  src/main.cpp
  src/platform.cpp
  src/protocol.cpp
  src/sha256.cpp
  src/compiler/diagnostics.cpp
  src/input/path_policy.cpp
  src/input/filelist.cpp
  src/extract/source_store.cpp
  src/extract/indexer.cpp
  src/store/sqlite_writer.cpp
  src/store/index_writer.cpp
)
target_include_directories(index-worker PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
  "${RTL_DEPS_DIR}")
target_link_libraries(index-worker PRIVATE slang::slang rtl_sqlite3 Threads::Threads)
target_compile_definitions(index-worker PRIVATE RTL_SLANG_COMMIT="${RTL_SLANG_COMMIT}")
set_target_properties(index-worker PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}")
if(RTL_MSVC_LIKE)
  target_compile_definitions(index-worker PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
  target_compile_options(index-worker PRIVATE
    /W4 /permissive- /utf-8 /bigobj /EHsc)
  target_link_options(index-worker PRIVATE
    "/MANIFEST:EMBED"
    "/MANIFESTINPUT:${CMAKE_CURRENT_SOURCE_DIR}/windows.manifest")
else()
  target_compile_options(index-worker PRIVATE -Wall -Wextra -Wno-unused-parameter)
  if(NOT APPLE)
    target_link_options(index-worker PRIVATE -static-libstdc++ -static-libgcc)
  endif()
endif()
