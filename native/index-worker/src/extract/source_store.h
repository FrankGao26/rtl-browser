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
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include <slang/text/SourceLocation.h>
#include <slang/text/SourceManager.h>

#include "input/path_policy.h"
#include "store/index_writer.h"

namespace rtl {

struct SourceInfo {
  int64_t id = 0;
  std::string displayPath;
  std::string sha;
  std::string data;
  std::vector<int64_t> lineStarts;
};

struct MappedSpan {
  bool valid = false;
  int64_t sourceId = 0;
  int64_t start = 0;
  int64_t end = 0;
  int64_t line = 0;
};

class SourceStore {
public:
  void capture(IndexWriter& writer, const slang::SourceManager& sm, const PathPolicy& paths,
               const std::string& outputDir, const std::vector<std::string>& excludeFiles = {});
  SourceInfo* byBuffer(slang::BufferID id);
  SourceInfo* byId(int64_t id);
  MappedSpan mapLocation(slang::SourceLocation loc, size_t fallbackLength = 0) const;
  MappedSpan mapRange(slang::SourceRange range, size_t fallbackLength = 0) const;
  int64_t lineFor(const SourceInfo& info, int64_t byteOffset) const;
  const std::vector<std::unique_ptr<SourceInfo>>& all() const { return infos_; }

private:
  std::vector<std::unique_ptr<SourceInfo>> infos_;
  std::unordered_map<uint32_t, SourceInfo*> byBuffer_;
  std::unordered_map<int64_t, SourceInfo*> byId_;
  std::unordered_map<std::string, SourceInfo*> byKey_;
};

} // namespace rtl
