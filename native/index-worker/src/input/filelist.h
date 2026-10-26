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
#include <stdexcept>
#include <string>
#include <vector>

namespace rtl {

class FilelistError : public std::runtime_error {
public:
  explicit FilelistError(const std::string& message) : std::runtime_error(message) {}
};

class FilelistNormalizer {
public:
  FilelistNormalizer(std::string projectRoot, std::string outputDir);

  /** Normalize a filelist (recursively) and return the path to a generated list. */
  std::string normalizeFilelist(const std::string& filelistPath);

  /** Build a normalized list from an ordered source list. */
  std::string normalizeSources(const std::vector<std::string>& sourcePaths);

private:
  std::string projectRoot_;
  std::string outputDir_;
  int generated_ = 0;

  void readFilelist(const std::string& file, std::vector<std::string>& out,
                    std::vector<std::string>& stack);
  std::string resolvePath(const std::string& raw, const std::string& label, bool directory);
  std::string expandEnv(const std::string& text);
  std::string writeTokens(const std::vector<std::string>& tokens);
  std::string quoteToken(const std::string& token) const;
};

} // namespace rtl
