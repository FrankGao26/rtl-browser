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
#include <optional>
#include <string>
#include <string_view>

#include "sqlite_writer.h"

namespace rtl {

struct SourceRecord {
  int64_t id = 0;
  std::string displayPath;
  std::string sha;
  int64_t bytes = 0;
  int64_t lineCount = 0;
};

struct OccurrenceRecord {
  int64_t bodyId = 0;
  int64_t sourceId = 0;
  int64_t startByte = 0;
  int64_t endByte = 0;
  std::string kind;
  std::string role;
  std::string status;
  std::optional<int64_t> targetSymbolId;
  std::optional<int64_t> targetInstanceId;
  std::optional<int64_t> targetSourceId;
  std::optional<int64_t> targetStartByte;
  std::optional<int64_t> targetEndByte;
  std::optional<int64_t> targetLine;
  std::optional<int64_t> targetMacroId;
  std::optional<int64_t> targetDefinitionId;
  std::string detail;
};

struct DriverRecord {
  int64_t bodyId = 0;
  int64_t instanceId = 0;
  int64_t targetSymbolId = 0;
  int64_t targetBitLo = 0;
  int64_t targetBitHi = 0;
  std::string kind;
  std::string sourceKind;
  int64_t sourceSymbolId = 0;
  int64_t sourceInstanceId = 0;
  int64_t sourceBitLo = 0;
  int64_t sourceBitHi = 0;
  int64_t sourceId = 0;
  int64_t startByte = 0;
  int64_t endByte = 0;
  int64_t line = 0;
  std::string exactness;
  std::string detail;
};

struct LoadRecord {
  int64_t sourceBodyId = 0;
  int64_t sourceInstanceId = 0;
  int64_t sourceSymbolId = 0;
  int64_t sourceBitLo = 0;
  int64_t sourceBitHi = 0;
  int64_t targetBodyId = 0;
  int64_t targetInstanceId = 0;
  int64_t targetSymbolId = 0;
  int64_t targetBitLo = 0;
  int64_t targetBitHi = 0;
  std::string role;
  std::string exactness;
  int64_t useSourceId = 0;
  int64_t useStartByte = 0;
  int64_t useEndByte = 0;
  int64_t targetSourceId = 0;
  int64_t targetStartByte = 0;
  int64_t targetEndByte = 0;
  std::string detail;
};

class IndexWriter {
public:
  IndexWriter(const std::string& outputDir, const std::string& schemaPath);
  ~IndexWriter();

  int64_t nextId() { return nextId_++; }
  SourceRecord addSource(std::string_view displayPath, std::string_view sha, int64_t bytes,
                         int64_t lineCount, std::string_view encoding, bool external);
  void addSourceLine(int64_t sourceId, int64_t line, int64_t start, int64_t end);
  int64_t addDefinition(std::string_view kind, std::string_view name, std::string_view qualified,
                        int64_t sourceId, int64_t start, int64_t end, int64_t line,
                        int64_t parentId);
  int64_t addScope(int64_t parentId, std::string_view kind, std::string_view name,
                   int64_t definitionId);
  int64_t addSourceScope(int64_t definitionId, std::string_view kind, std::string_view name,
                         int64_t sourceId, int64_t start, int64_t end, int64_t lineStart,
                         int64_t lineEnd);
  int64_t addInactiveRegion(int64_t bodyId, int64_t ownerInstanceId, std::string_view kind,
                            std::string_view label, int64_t sourceId, int64_t start, int64_t end,
                            int64_t lineStart, int64_t lineEnd);
  int64_t addPreprocessorRegion(int64_t sourceId, int64_t start, int64_t end, int64_t lineStart,
                                int64_t lineEnd, std::string_view kind, std::string_view label);
  int64_t addBody(int64_t definitionId, std::string_view moduleName,
                  std::string_view parameterSignature, int64_t canonicalBodyId);
  int64_t addInstance(int64_t parentId, int64_t ordinal, std::string_view name,
                      std::string_view moduleName, int64_t definitionId, int64_t bodyId,
                      int64_t scopeId, std::string_view path, int64_t sourceId, int64_t start,
                      int64_t end, int64_t line, int64_t depth, bool instanceArray);
  int64_t addSymbol(int64_t bodyId, int64_t scopeId, int64_t parentSymbolId, std::string_view name,
                    std::string_view kind, std::string_view declaredType, std::string_view actualType,
                    std::optional<int64_t> width, std::optional<bool> isSigned,
                    std::string_view packedDims, std::string_view unpackedDims,
                    std::string_view direction, std::string_view defaultValue,
                    std::string_view actualValue, int64_t sourceId, int64_t start, int64_t end,
                    int64_t line, int64_t definitionId);
  void addSymbolAlias(int64_t symbolId, int64_t aliasSymbolId);
  int64_t addOccurrence(const OccurrenceRecord& record);
  int64_t addMacroDefinition(std::string_view name, int64_t sourceId, int64_t start, int64_t end,
                             int64_t line, std::string_view body);
  int64_t addInclude(int64_t sourceId, int64_t start, int64_t end, int64_t targetSourceId,
                     bool isSystem);
  int64_t addImport(int64_t bodyId, int64_t sourceId, int64_t start, int64_t end,
                    std::string_view packageName, int64_t targetDefinitionId,
                    int64_t targetSourceId, int64_t targetStart, int64_t targetLine);
  int64_t addMacroUse(int64_t bodyId, int64_t sourceId, int64_t start, int64_t end,
                      int64_t definitionId);
  int64_t addDriver(const DriverRecord& record);
  int64_t addLoad(const LoadRecord& record);
  void setMeta(std::string_view key, std::string_view value);
  void commit();
  void rollback();
  void close();
  SqliteDb& db() { return db_; }

private:
  SqliteDb db_;
  int64_t nextId_ = 1;
  Stmt insSource_;
  Stmt insLine_;
  Stmt insDef_;
  Stmt insScope_;
  Stmt insSourceScope_;
  Stmt insInactiveRegion_;
  Stmt insPreprocessorRegion_;
  Stmt insBody_;
  Stmt insInstance_;
  Stmt insSymbol_;
  Stmt insSymbolAlias_;
  Stmt insOcc_;
  Stmt insMacro_;
  Stmt insInclude_;
  Stmt insImport_;
  Stmt insMacroUse_;
  Stmt insDriver_;
  Stmt insLoad_;
  Stmt insMeta_;
};

} // namespace rtl
