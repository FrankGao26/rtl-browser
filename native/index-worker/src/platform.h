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

#pragma once

#include <cstdio>
#include <ctime>
#include <filesystem>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace rtl::platform {

std::filesystem::path fromUtf8(std::string_view text);
std::string toUtf8(const std::filesystem::path& path);
std::string genericUtf8(const std::filesystem::path& path);

// For internal file I/O only; do not persist or display the Windows prefix.
std::filesystem::path fileIoPath(const std::filesystem::path& path);

bool setCurrentDirectory(const std::filesystem::path& path);
bool isReadable(const std::filesystem::path& path);
std::optional<std::string> getEnv(std::string_view name);
std::tm gmtime(std::time_t value);

int duplicateFd(int fd);
int redirectFd(int from, int to);
int closeFd(int fd);
FILE* fdopenFd(int fd, const char* mode);
void setBinaryFd(int fd);

bool samePath(const std::filesystem::path& a, const std::filesystem::path& b);
bool isWithin(const std::filesystem::path& root, const std::filesystem::path& candidate);
std::string relativeGeneric(const std::filesystem::path& root,
                            const std::filesystem::path& candidate);
std::string replacePathInsensitive(std::string text, std::string_view needle,
                                   std::string_view replacement);

#ifdef _WIN32
std::vector<std::string> wideArgsToUtf8(int argc, wchar_t** argv);
#endif

} // namespace rtl::platform
