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

#include "path_policy.h"

#include <algorithm>
#include <filesystem>

#include "../platform.h"

namespace rtl {
namespace fs = std::filesystem;

namespace {

std::string canonicalRoot(const std::string& root) {
  if (root.empty()) return {};
  std::error_code ec;
  const fs::path canon = fs::weakly_canonical(platform::fromUtf8(root), ec);
  if (ec) return root;
  return platform::genericUtf8(canon);
}

} // namespace

PathPolicy::PathPolicy(std::string workingDirectory, std::vector<std::string> sourceRoots,
                       std::string projectRoot)
    : workingDirectory_(std::move(workingDirectory)), projectRoot_(std::move(projectRoot)) {
  roots_.push_back(canonicalRoot(workingDirectory_));
  for (const auto& r : sourceRoots) roots_.push_back(canonicalRoot(r));
  if (!projectRoot_.empty()) roots_.push_back(canonicalRoot(projectRoot_));
  roots_.erase(std::remove(roots_.begin(), roots_.end(), std::string()), roots_.end());
  std::sort(roots_.begin(), roots_.end());
  roots_.erase(std::unique(roots_.begin(), roots_.end()), roots_.end());
  std::sort(roots_.begin(), roots_.end(), [](const auto& a, const auto& b) { return a.size() > b.size(); });
}

std::string PathPolicy::displayPath(std::string_view file) const {
  if (file.empty()) return {};
  fs::path p = platform::fromUtf8(file);
  std::error_code ec;
  fs::path canon = fs::weakly_canonical(p, ec);
  if (ec) canon = p.lexically_normal();
  if (!canon.is_absolute()) return platform::genericUtf8(canon);
  for (const auto& root : roots_) {
    if (root.empty()) continue;
    const fs::path rootPath = platform::fromUtf8(root);
    if (platform::isWithin(rootPath, canon)) {
      std::string rel = platform::relativeGeneric(rootPath, canon);
      return rel.empty() ? platform::genericUtf8(canon.filename()) : rel;
    }
  }
  return "external/" + platform::genericUtf8(canon.filename());
}

std::string PathPolicy::sanitizeText(std::string_view text) const {
  std::string out(text);
  for (const auto& root : roots_) {
    if (root.empty()) continue;
    out = platform::replacePathInsensitive(out, root, "<root>");
    const auto native = platform::toUtf8(platform::fromUtf8(root));
    if (native != root) out = platform::replacePathInsensitive(out, native, "<root>");
    const auto generic = platform::genericUtf8(platform::fromUtf8(root));
    if (generic != root && generic != native) {
      out = platform::replacePathInsensitive(out, generic, "<root>");
    }
  }
  return out;
}

} // namespace rtl
