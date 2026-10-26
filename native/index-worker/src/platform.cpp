// Copyright 2026 Frank Gao
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

#include "platform.h"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <cwctype>
#include <stdexcept>
#include <system_error>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <direct.h>
#include <windows.h>
#else
#include <unistd.h>
#endif

namespace rtl::platform {

#ifdef _WIN32

namespace {

std::wstring utf8ToWide(std::string_view text) {
  if (text.empty()) return {};
  const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(),
                                         static_cast<int>(text.size()), nullptr, 0);
  if (length <= 0) throw std::runtime_error("invalid UTF-8 path");
  std::wstring out(static_cast<size_t>(length), L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(),
                      static_cast<int>(text.size()), out.data(), length);
  return out;
}

std::string wideToUtf8(std::wstring_view text) {
  if (text.empty()) return {};
  const int length = WideCharToMultiByte(CP_UTF8, 0, text.data(),
                                         static_cast<int>(text.size()), nullptr, 0,
                                         nullptr, nullptr);
  if (length <= 0) throw std::runtime_error("invalid Windows path");
  std::string out(static_cast<size_t>(length), '\0');
  WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()),
                      out.data(), length, nullptr, nullptr);
  return out;
}

std::wstring trimTrailingSeparators(std::wstring value) {
  while (value.size() > 1) {
    const wchar_t last = value.back();
    if (last != L'\\' && last != L'/') break;
    if (value.size() == 3 && value[1] == L':') break;
    value.pop_back();
  }
  return value;
}

bool equalChar(wchar_t a, wchar_t b) {
  return std::towlower(a) == std::towlower(b);
}

bool prefixPath(const std::wstring& root, const std::wstring& candidate) {
  if (candidate.size() < root.size()) return false;
  for (size_t i = 0; i < root.size(); i++) {
    if (!equalChar(root[i], candidate[i])) return false;
  }
  if (candidate.size() == root.size()) return true;
  if (!root.empty() && (root.back() == L'\\' || root.back() == L'/')) return true;
  return candidate[root.size()] == L'\\' || candidate[root.size()] == L'/';
}

std::wstring normalizedWide(const std::filesystem::path& path) {
  return trimTrailingSeparators(path.lexically_normal().wstring());
}

} // namespace

std::filesystem::path fromUtf8(std::string_view text) {
  return std::filesystem::path(utf8ToWide(text));
}

std::string toUtf8(const std::filesystem::path& path) {
  return wideToUtf8(path.native());
}

std::string genericUtf8(const std::filesystem::path& path) {
  return wideToUtf8(path.generic_wstring());
}

bool setCurrentDirectory(const std::filesystem::path& path) {
  return _wchdir(path.c_str()) == 0;
}

bool isReadable(const std::filesystem::path& path) {
  return _waccess(path.c_str(), 4) == 0;
}

std::optional<std::string> getEnv(std::string_view name) {
  const std::wstring key = utf8ToWide(name);
  const wchar_t* value = _wgetenv(key.c_str());
  if (!value) return std::nullopt;
  return wideToUtf8(value);
}

std::tm gmtime(std::time_t value) {
  std::tm out{};
  gmtime_s(&out, &value);
  return out;
}

int duplicateFd(int fd) { return _dup(fd); }
int redirectFd(int from, int to) { return _dup2(from, to); }
int closeFd(int fd) { return _close(fd); }
FILE* fdopenFd(int fd, const char* mode) { return _fdopen(fd, mode); }
void setBinaryFd(int fd) { _setmode(fd, _O_BINARY); }

bool samePath(const std::filesystem::path& a, const std::filesystem::path& b) {
  std::error_code ec;
  if (std::filesystem::exists(a, ec) && !ec && std::filesystem::exists(b, ec) && !ec) {
    bool equal = std::filesystem::equivalent(a, b, ec);
    if (!ec) return equal;
  }
  return prefixPath(normalizedWide(a), normalizedWide(b)) &&
         prefixPath(normalizedWide(b), normalizedWide(a));
}

bool isWithin(const std::filesystem::path& root, const std::filesystem::path& candidate) {
  return prefixPath(normalizedWide(root), normalizedWide(candidate));
}

std::string relativeGeneric(const std::filesystem::path& root,
                            const std::filesystem::path& candidate) {
  const std::wstring r = normalizedWide(root);
  const std::wstring p = normalizedWide(candidate);
  if (!prefixPath(r, p)) return {};
  size_t start = r.size();
  if (start < p.size() && (p[start] == L'\\' || p[start] == L'/')) start++;
  if (start >= p.size()) return {};
  return genericUtf8(std::filesystem::path(p.substr(start)));
}

std::string replacePathInsensitive(std::string text, std::string_view needle,
                                   std::string_view replacement) {
  if (needle.empty()) return text;
  auto equalAscii = [](char a, char b) {
    return std::tolower(static_cast<unsigned char>(a)) ==
           std::tolower(static_cast<unsigned char>(b));
  };
  size_t pos = 0;
  while (pos + needle.size() <= text.size()) {
    bool match = true;
    for (size_t i = 0; i < needle.size(); i++) {
      if (!equalAscii(text[pos + i], needle[i])) { match = false; break; }
    }
    if (!match) { pos++; continue; }
    text.replace(pos, needle.size(), replacement);
    pos += replacement.size();
  }
  return text;
}

std::vector<std::string> wideArgsToUtf8(int argc, wchar_t** argv) {
  std::vector<std::string> out;
  out.reserve(static_cast<size_t>(argc));
  for (int i = 0; i < argc; i++) out.push_back(wideToUtf8(argv[i]));
  return out;
}

#else

std::filesystem::path fromUtf8(std::string_view text) {
  return std::filesystem::path(std::string(text));
}

std::string toUtf8(const std::filesystem::path& path) {
  return path.string();
}

std::string genericUtf8(const std::filesystem::path& path) {
  return path.generic_string();
}

bool setCurrentDirectory(const std::filesystem::path& path) {
  return chdir(path.c_str()) == 0;
}

bool isReadable(const std::filesystem::path& path) {
  return access(path.c_str(), R_OK) == 0;
}

std::optional<std::string> getEnv(std::string_view name) {
  const std::string key(name);
  const char* value = std::getenv(key.c_str());
  if (!value) return std::nullopt;
  return std::string(value);
}

std::tm gmtime(std::time_t value) {
  std::tm out{};
  gmtime_r(&value, &out);
  return out;
}

int duplicateFd(int fd) { return dup(fd); }
int redirectFd(int from, int to) { return dup2(from, to); }
int closeFd(int fd) { return close(fd); }
FILE* fdopenFd(int fd, const char* mode) { return fdopen(fd, mode); }
void setBinaryFd(int) {}

bool samePath(const std::filesystem::path& a, const std::filesystem::path& b) {
  std::error_code ec;
  if (std::filesystem::exists(a, ec) && !ec && std::filesystem::exists(b, ec) && !ec) {
    bool equal = std::filesystem::equivalent(a, b, ec);
    if (!ec) return equal;
  }
  return std::filesystem::weakly_canonical(a, ec) == std::filesystem::weakly_canonical(b, ec);
}

bool isWithin(const std::filesystem::path& root, const std::filesystem::path& candidate) {
  const auto r = root.lexically_normal();
  const auto p = candidate.lexically_normal();
  const auto rel = p.lexically_relative(r);
  if (rel.empty()) return p == r;
  const std::string s = rel.generic_string();
  return s != ".." && s.rfind("../", 0) != 0;
}

std::string relativeGeneric(const std::filesystem::path& root,
                            const std::filesystem::path& candidate) {
  const auto rel = candidate.lexically_normal().lexically_relative(root.lexically_normal());
  return rel.empty() ? std::string() : rel.generic_string();
}

std::string replacePathInsensitive(std::string text, std::string_view needle,
                                   std::string_view replacement) {
  if (needle.empty()) return text;
  size_t pos = 0;
  while ((pos = text.find(needle, pos)) != std::string::npos) {
    text.replace(pos, needle.size(), replacement);
    pos += replacement.size();
  }
  return text;
}

#endif

} // namespace rtl::platform
