// Copyright 2026 Frank Gao
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
// http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <string>

#include "platform.h"

namespace fs = std::filesystem;

static void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

int main(int argc, char** argv) {
  try {
    require(argc == 2, "usage: native-path-io OUTPUT_PARENT");
    require(rtl::platform::fileIoPath(fs::path()).empty(), "empty path changed");
    const fs::path relative = fs::path("relative") / ".." / "source.sv";
#ifdef _WIN32
    const auto normalized = fs::absolute(relative).lexically_normal().make_preferred();
    const auto extended = fs::path(L"\\\\?\\" + normalized.native());
    require(rtl::platform::fileIoPath(relative) == extended, "relative path not normalized");
    require(rtl::platform::fileIoPath(extended) == extended, "extended path prefixed twice");
    require(rtl::platform::fileIoPath(fs::path(L"\\\\server\\share\\dir\\..\\file")) ==
                fs::path(L"\\\\?\\UNC\\server\\share\\file"), "UNC path conversion failed");
    const fs::path device(L"\\\\.\\NUL");
    require(rtl::platform::fileIoPath(device) == device, "device path changed");
#else
    require(rtl::platform::fileIoPath(relative).native() == relative.native(),
            "POSIX relative path changed");
    const fs::path absolute("/tmp/../source.sv");
    require(rtl::platform::fileIoPath(absolute).native() == absolute.native(),
            "POSIX absolute path changed");
#endif
    const auto unique = std::chrono::steady_clock::now().time_since_epoch().count();
    const auto root = fs::absolute(rtl::platform::fromUtf8(argv[1])) /
                      ("path-io-probe-" + std::to_string(unique));
    auto directory = root / rtl::platform::fromUtf8("中文 folder");
    while ((directory / (std::string(64, 'a') + ".bin")).native().size() <= 320)
      directory /= std::string(48, 'b');
    fs::create_directories(rtl::platform::fileIoPath(directory));
    const auto blob = directory / (std::string(64, 'a') + ".bin");
    bool plainWrite = false;
    {
      std::ofstream plain(blob, std::ios::binary);
      plainWrite = bool(plain);
    }
    const auto ioBlob = rtl::platform::fileIoPath(blob);
    const std::string contents = "long-path source snapshot\n";
    {
      std::ofstream output(ioBlob, std::ios::binary);
      require(bool(output), "extended source blob open failed");
      output.write(contents.data(), std::streamsize(contents.size()));
      output.close();
      require(bool(output), "extended source blob write failed");
    }
    {
      std::ifstream input(ioBlob, std::ios::binary);
      require(bool(input), "extended source blob read failed");
      const std::string actual{std::istreambuf_iterator<char>(input),
                               std::istreambuf_iterator<char>()};
      require(actual == contents, "source blob contents changed");
    }
    require(rtl::platform::toUtf8(blob).find("\\\\?\\") == std::string::npos,
            "internal prefix leaked into original path");
    fs::remove_all(rtl::platform::fileIoPath(root));
    std::cout << "native-path-io: PASS; pathLength=" << blob.native().size()
              << "; plainWrite=" << plainWrite << '\n';
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "native-path-io: FAIL: " << error.what() << '\n';
    return 1;
  }
}
