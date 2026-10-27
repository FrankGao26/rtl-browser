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

#include "source_store.h"

#include <algorithm>
#include <cerrno>
#include <filesystem>
#include <fstream>
#include <system_error>

#include "../platform.h"
#include "../sha256.h"

namespace rtl {
namespace fs = std::filesystem;

void SourceStore::capture(IndexWriter& writer, const slang::SourceManager& sm, const PathPolicy& paths,
                          const std::string& outputDir, const std::vector<std::string>& excludeFiles) {
  const fs::path sourcesDir = platform::fileIoPath(platform::fromUtf8(outputDir) / "sources");
  fs::create_directories(sourcesDir);
  for (slang::BufferID buffer : sm.getAllBuffers()) {
    auto kind = sm.getBufferKind(buffer);
    if (kind != slang::SourceManager::BufferKind::DesignFile &&
        kind != slang::SourceManager::BufferKind::IncludeFile &&
        kind != slang::SourceManager::BufferKind::LibraryFile) {
      continue;
    }
    std::string_view data = sm.getSourceText(buffer);
    while (!data.empty() && data.back() == '\0') data.remove_suffix(1);
    std::string display;
    const auto& full = sm.getFullPath(buffer);
    const fs::path fullPath = full;
    if (!full.empty()) {
      bool excluded = false;
      for (const auto& excludeFile : excludeFiles) {
        if (!excludeFile.empty() &&
            platform::samePath(fullPath, platform::fromUtf8(excludeFile))) {
          excluded = true;
          break;
        }
      }
      if (excluded) continue;
    }
    if (!full.empty()) display = paths.displayPath(platform::genericUtf8(fullPath));
    else display = paths.displayPath(std::string(sm.getRawFileName(buffer)));
    if (display.empty()) display = "external/buffer_" + std::to_string(buffer.getId());
    std::string sha = sha256Hex(data);
    std::string key = display + "\n" + sha;
    auto it = byKey_.find(key);
    if (it != byKey_.end()) {
      byBuffer_[buffer.getId()] = it->second;
      continue;
    }

    auto info = std::make_unique<SourceInfo>();
    info->displayPath = display;
    info->sha = sha;
    info->data.assign(data.data(), data.size());
    if (info->data.empty()) {
      info->lineStarts.push_back(0);
    } else {
      info->lineStarts.push_back(0);
      for (size_t i = 0; i < info->data.size(); i++) {
        if (info->data[i] == '\n' && i + 1 < info->data.size()) info->lineStarts.push_back(int64_t(i + 1));
      }
    }

    const fs::path blob = sourcesDir / (sha + ".bin");
    if (!fs::exists(blob)) {
      std::ofstream out(blob, std::ios::binary);
      if (!out) {
        const int error = errno;
        throw std::runtime_error("cannot write source blob " + platform::toUtf8(blob) +
                                 ": " + std::error_code(error, std::generic_category()).message());
      }
      out.write(info->data.data(), std::streamsize(info->data.size()));
      out.close();
      if (!out) throw std::runtime_error("cannot finish source blob " + platform::toUtf8(blob));
#ifndef _WIN32
      std::error_code ec;
      fs::permissions(blob, fs::perms::owner_read | fs::perms::group_read | fs::perms::others_read,
                      fs::perm_options::replace, ec);
#endif
    }

    info->id = writer.addSource(info->displayPath, info->sha, int64_t(info->data.size()),
                                int64_t(info->lineStarts.size()), "utf-8",
                                info->displayPath.rfind("external/", 0) == 0).id;
    for (size_t i = 0; i < info->lineStarts.size(); i++) {
      int64_t start = info->lineStarts[i];
      int64_t end = (i + 1 < info->lineStarts.size()) ? info->lineStarts[i + 1]
                                                       : int64_t(info->data.size());
      writer.addSourceLine(info->id, int64_t(i + 1), start, end);
    }
    byBuffer_[buffer.getId()] = info.get();
    byId_[info->id] = info.get();
    byKey_[key] = info.get();
    infos_.push_back(std::move(info));
  }
}

SourceInfo* SourceStore::byBuffer(slang::BufferID id) {
  auto it = byBuffer_.find(id.getId());
  return it == byBuffer_.end() ? nullptr : it->second;
}

SourceInfo* SourceStore::byId(int64_t id) {
  auto it = byId_.find(id);
  return it == byId_.end() ? nullptr : it->second;
}

int64_t SourceStore::lineFor(const SourceInfo& info, int64_t byteOffset) const {
  if (info.lineStarts.empty()) return 1;
  auto it = std::upper_bound(info.lineStarts.begin(), info.lineStarts.end(), byteOffset);
  if (it == info.lineStarts.begin()) return 1;
  return int64_t(std::distance(info.lineStarts.begin(), it));
}

MappedSpan SourceStore::mapLocation(slang::SourceLocation loc, size_t fallbackLength) const {
  MappedSpan out;
  if (!loc.valid()) return out;
  for (int guard = 0; guard < 32 && (loc.valid()); guard++) {
    SourceInfo* info = nullptr;
    auto it = byBuffer_.find(loc.buffer().getId());
    if (it != byBuffer_.end()) info = it->second;
    if (info) {
      out.valid = true;
      out.sourceId = info->id;
      out.start = int64_t(loc.offset());
      out.end = std::min<int64_t>(int64_t(info->data.size()), out.start + int64_t(fallbackLength));
      out.line = lineFor(*info, out.start);
      return out;
    }
    // Macro locations are not source files; navigate to their original file
    // location. A macro argument is also not a physical file buffer.
    if (loc.buffer().valid()) {
      // SourceManager is not available here; the caller maps ranges. This
      // fallback is handled in mapRange by using the start buffer.
    }
    return out;
  }
  return out;
}

MappedSpan SourceStore::mapRange(slang::SourceRange range, size_t fallbackLength) const {
  auto start = mapLocation(range.start(), fallbackLength);
  if (!start.valid) return start;
  auto end = mapLocation(range.end(), 0);
  if (end.valid && end.sourceId == start.sourceId && end.start >= start.start) {
    start.end = end.start;
  }
  return start;
}

} // namespace rtl
