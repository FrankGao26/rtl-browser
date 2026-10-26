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

#include "index_writer.h"

#include <filesystem>
#include <fstream>
#include <stdexcept>

#include "../platform.h"

namespace rtl {
namespace fs = std::filesystem;

static std::string readFile(const std::string& path) {
  std::ifstream in(platform::fromUtf8(path), std::ios::binary);
  if (!in) throw std::runtime_error("cannot read schema: " + path);
  return std::string(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
}

IndexWriter::IndexWriter(const std::string& outputDir, const std::string& schemaPath)
    : db_(platform::toUtf8(platform::fromUtf8(outputDir) / "index.sqlite")) {
  fs::create_directories(platform::fromUtf8(outputDir));
  db_.exec("PRAGMA journal_mode=DELETE;");
  db_.exec("PRAGMA synchronous=FULL;");
  db_.exec("PRAGMA foreign_keys=ON;");
  db_.exec("PRAGMA temp_store=FILE;");
  db_.exec("PRAGMA cache_size=-65536;");
  db_.exec("PRAGMA application_id=1381256258;");
  db_.exec(readFile(schemaPath));

  insSource_ = db_.prepare("INSERT INTO source_file(id,display_path,blob_sha,byte_length,line_count,encoding,external) VALUES(?,?,?,?,?,?,?)");
  insLine_ = db_.prepare("INSERT INTO source_line(source_id,line_no,start_byte,end_byte) VALUES(?,?,?,?)");
  insDef_ = db_.prepare("INSERT INTO definition(id,kind,name,qualified_name,source_id,start_byte,end_byte,line,parent_id) VALUES(?,?,?,?,?,?,?,?,?)");
  insScope_ = db_.prepare("INSERT INTO scope(id,parent_id,kind,name,definition_id) VALUES(?,?,?,?,?)");
  insSourceScope_ = db_.prepare("INSERT INTO source_scope(id,definition_id,source_id,start_byte,end_byte,line_start,line_end,kind,name) VALUES(?,?,?,?,?,?,?,?,?)");
  insInactiveRegion_ = db_.prepare("INSERT INTO inactive_region(id,body_id,owner_instance_id,source_id,start_byte,end_byte,line_start,line_end,kind,label) VALUES(?,?,?,?,?,?,?,?,?,?)");
  insPreprocessorRegion_ = db_.prepare("INSERT INTO preprocessor_region(id,source_id,start_byte,end_byte,line_start,line_end,kind,label) VALUES(?,?,?,?,?,?,?,?)");
  insBody_ = db_.prepare("INSERT INTO body(id,definition_id,module_name,parameter_signature,canonical_body_id) VALUES(?,?,?,?,?)");
  insInstance_ = db_.prepare("INSERT INTO instance(id,parent_id,ordinal,name,module_name,definition_id,body_id,scope_id,path,source_id,start_byte,end_byte,line,depth,is_instance_array) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  insSymbol_ = db_.prepare("INSERT INTO symbol(id,body_id,scope_id,parent_symbol_id,name,kind,declared_type,actual_type,width,is_signed,packed_dims,unpacked_dims,direction,default_value,actual_value,source_id,start_byte,end_byte,line,definition_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  insSymbolAlias_ = db_.prepare("INSERT INTO symbol_alias(symbol_id,alias_symbol_id) VALUES(?,?)");
  insOcc_ = db_.prepare("INSERT INTO occurrence(id,body_id,source_id,start_byte,end_byte,kind,role,status,target_symbol_id,target_instance_id,target_source_id,target_start_byte,target_end_byte,target_line,target_macro_id,target_definition_id,detail) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  insMacro_ = db_.prepare("INSERT INTO macro_definition(id,name,source_id,start_byte,end_byte,line,body) VALUES(?,?,?,?,?,?,?)");
  insInclude_ = db_.prepare("INSERT INTO include_link(id,source_id,start_byte,end_byte,target_source_id,is_system) VALUES(?,?,?,?,?,?)");
  insImport_ = db_.prepare("INSERT INTO import_link(id,body_id,source_id,start_byte,end_byte,package_name,target_definition_id,target_source_id,target_start_byte,target_line) VALUES(?,?,?,?,?,?,?,?,?,?)");
  insMacroUse_ = db_.prepare("INSERT INTO macro_use(id,body_id,source_id,start_byte,end_byte,definition_id) VALUES(?,?,?,?,?,?)");
  insDriver_ = db_.prepare("INSERT INTO driver(id,body_id,instance_id,target_symbol_id,target_bit_lo,target_bit_hi,kind,source_symbol_id,source_instance_id,source_bit_lo,source_bit_hi,source_id,start_byte,end_byte,line,exactness,detail) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  insLoad_ = db_.prepare("INSERT INTO load_edge(id,source_body_id,source_instance_id,source_symbol_id,source_bit_lo,source_bit_hi,target_body_id,target_instance_id,target_symbol_id,target_bit_lo,target_bit_hi,role,exactness,use_source_id,use_start_byte,use_end_byte,target_source_id,target_start_byte,target_end_byte,detail) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  insMeta_ = db_.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)");

  db_.begin();
  setMeta("schema_version", "1");
  setMeta("extractor_version", "0.9.11");
}

IndexWriter::~IndexWriter() = default;

void IndexWriter::setMeta(std::string_view key, std::string_view value) {
  insMeta_.bind(1, key).bind(2, value).exec();
}

SourceRecord IndexWriter::addSource(std::string_view displayPath, std::string_view sha,
                                    int64_t bytes, int64_t lineCount, std::string_view encoding,
                                    bool external) {
  SourceRecord r;
  r.id = nextId();
  r.displayPath = std::string(displayPath);
  r.sha = std::string(sha);
  r.bytes = bytes;
  r.lineCount = lineCount;
  insSource_.bind(1, r.id).bind(2, displayPath).bind(3, sha).bind(4, bytes).bind(5, lineCount)
      .bind(6, encoding).bind(7, int64_t(external ? 1 : 0)).exec();
  return r;
}

void IndexWriter::addSourceLine(int64_t sourceId, int64_t line, int64_t start, int64_t end) {
  insLine_.bind(1, sourceId).bind(2, line).bind(3, start).bind(4, end).exec();
}

int64_t IndexWriter::addDefinition(std::string_view kind, std::string_view name,
                                   std::string_view qualified, int64_t sourceId, int64_t start,
                                   int64_t end, int64_t line, int64_t parentId) {
  int64_t id = nextId();
  insDef_.bind(1, id).bind(2, kind).bind(3, name).bind(4, qualified);
  if (sourceId) insDef_.bind(5, sourceId); else insDef_.bindNull(5);
  if (start) insDef_.bind(6, start); else insDef_.bindNull(6);
  if (end) insDef_.bind(7, end); else insDef_.bindNull(7);
  if (line) insDef_.bind(8, line); else insDef_.bindNull(8);
  if (parentId) insDef_.bind(9, parentId); else insDef_.bindNull(9);
  insDef_.exec();
  return id;
}

int64_t IndexWriter::addScope(int64_t parentId, std::string_view kind, std::string_view name,
                              int64_t definitionId) {
  int64_t id = nextId();
  insScope_.bind(1, id);
  if (parentId) insScope_.bind(2, parentId); else insScope_.bindNull(2);
  insScope_.bind(3, kind).bind(4, name);
  if (definitionId) insScope_.bind(5, definitionId); else insScope_.bindNull(5);
  insScope_.exec();
  return id;
}

int64_t IndexWriter::addSourceScope(int64_t definitionId, std::string_view kind,
                                    std::string_view name, int64_t sourceId, int64_t start,
                                    int64_t end, int64_t lineStart, int64_t lineEnd) {
  int64_t id = nextId();
  insSourceScope_.bind(1, id);
  if (definitionId) insSourceScope_.bind(2, definitionId); else insSourceScope_.bindNull(2);
  insSourceScope_.bind(3, sourceId).bind(4, start).bind(5, end);
  if (lineStart) insSourceScope_.bind(6, lineStart); else insSourceScope_.bindNull(6);
  if (lineEnd) insSourceScope_.bind(7, lineEnd); else insSourceScope_.bindNull(7);
  insSourceScope_.bind(8, kind).bind(9, name).exec();
  return id;
}

int64_t IndexWriter::addInactiveRegion(int64_t bodyId, int64_t ownerInstanceId,
                                       std::string_view kind, std::string_view label,
                                       int64_t sourceId, int64_t start, int64_t end,
                                       int64_t lineStart, int64_t lineEnd) {
  int64_t id = nextId();
  insInactiveRegion_.bind(1, id).bind(2, bodyId);
  if (ownerInstanceId) insInactiveRegion_.bind(3, ownerInstanceId); else insInactiveRegion_.bindNull(3);
  insInactiveRegion_.bind(4, sourceId).bind(5, start).bind(6, end);
  if (lineStart) insInactiveRegion_.bind(7, lineStart); else insInactiveRegion_.bindNull(7);
  if (lineEnd) insInactiveRegion_.bind(8, lineEnd); else insInactiveRegion_.bindNull(8);
  insInactiveRegion_.bind(9, kind);
  if (label.empty()) insInactiveRegion_.bindNull(10); else insInactiveRegion_.bind(10, label);
  insInactiveRegion_.exec();
  return id;
}

int64_t IndexWriter::addPreprocessorRegion(int64_t sourceId, int64_t start, int64_t end,
                                           int64_t lineStart, int64_t lineEnd,
                                           std::string_view kind, std::string_view label) {
  int64_t id = nextId();
  insPreprocessorRegion_.bind(1, id).bind(2, sourceId).bind(3, start).bind(4, end);
  if (lineStart) insPreprocessorRegion_.bind(5, lineStart); else insPreprocessorRegion_.bindNull(5);
  if (lineEnd) insPreprocessorRegion_.bind(6, lineEnd); else insPreprocessorRegion_.bindNull(6);
  insPreprocessorRegion_.bind(7, kind);
  if (label.empty()) insPreprocessorRegion_.bindNull(8); else insPreprocessorRegion_.bind(8, label);
  insPreprocessorRegion_.exec();
  return id;
}

int64_t IndexWriter::addBody(int64_t definitionId, std::string_view moduleName,
                             std::string_view parameterSignature, int64_t canonicalBodyId) {
  int64_t id = nextId();
  insBody_.bind(1, id);
  if (definitionId) insBody_.bind(2, definitionId); else insBody_.bindNull(2);
  insBody_.bind(3, moduleName).bind(4, parameterSignature);
  if (canonicalBodyId) insBody_.bind(5, canonicalBodyId); else insBody_.bindNull(5);
  insBody_.exec();
  return id;
}

int64_t IndexWriter::addInstance(int64_t parentId, int64_t ordinal, std::string_view name,
                                 std::string_view moduleName, int64_t definitionId, int64_t bodyId,
                                 int64_t scopeId, std::string_view path, int64_t sourceId,
                                 int64_t start, int64_t end, int64_t line, int64_t depth,
                                 bool instanceArray) {
  int64_t id = nextId();
  insInstance_.bind(1, id);
  if (parentId) insInstance_.bind(2, parentId); else insInstance_.bindNull(2);
  insInstance_.bind(3, ordinal).bind(4, name).bind(5, moduleName);
  if (definitionId) insInstance_.bind(6, definitionId); else insInstance_.bindNull(6);
  insInstance_.bind(7, bodyId);
  if (scopeId) insInstance_.bind(8, scopeId); else insInstance_.bindNull(8);
  insInstance_.bind(9, path);
  if (sourceId) insInstance_.bind(10, sourceId); else insInstance_.bindNull(10);
  if (start) insInstance_.bind(11, start); else insInstance_.bindNull(11);
  if (end) insInstance_.bind(12, end); else insInstance_.bindNull(12);
  if (line) insInstance_.bind(13, line); else insInstance_.bindNull(13);
  insInstance_.bind(14, depth).bind(15, int64_t(instanceArray ? 1 : 0)).exec();
  return id;
}

int64_t IndexWriter::addSymbol(int64_t bodyId, int64_t scopeId, int64_t parentSymbolId,
                               std::string_view name, std::string_view kind,
                               std::string_view declaredType, std::string_view actualType,
                               std::optional<int64_t> width, std::optional<bool> isSigned,
                               std::string_view packedDims, std::string_view unpackedDims,
                               std::string_view direction, std::string_view defaultValue,
                               std::string_view actualValue, int64_t sourceId, int64_t start,
                               int64_t end, int64_t line, int64_t definitionId) {
  int64_t id = nextId();
  insSymbol_.bind(1, id);
  if (bodyId) insSymbol_.bind(2, bodyId); else insSymbol_.bindNull(2);
  if (scopeId) insSymbol_.bind(3, scopeId); else insSymbol_.bindNull(3);
  if (parentSymbolId) insSymbol_.bind(4, parentSymbolId); else insSymbol_.bindNull(4);
  insSymbol_.bind(5, name).bind(6, kind);
  if (!declaredType.empty()) insSymbol_.bind(7, declaredType); else insSymbol_.bindNull(7);
  if (!actualType.empty()) insSymbol_.bind(8, actualType); else insSymbol_.bindNull(8);
  if (width) insSymbol_.bind(9, *width); else insSymbol_.bindNull(9);
  if (isSigned) insSymbol_.bind(10, int64_t(*isSigned ? 1 : 0)); else insSymbol_.bindNull(10);
  if (!packedDims.empty()) insSymbol_.bind(11, packedDims); else insSymbol_.bindNull(11);
  if (!unpackedDims.empty()) insSymbol_.bind(12, unpackedDims); else insSymbol_.bindNull(12);
  if (!direction.empty()) insSymbol_.bind(13, direction); else insSymbol_.bindNull(13);
  if (!defaultValue.empty()) insSymbol_.bind(14, defaultValue); else insSymbol_.bindNull(14);
  if (!actualValue.empty()) insSymbol_.bind(15, actualValue); else insSymbol_.bindNull(15);
  if (sourceId) insSymbol_.bind(16, sourceId); else insSymbol_.bindNull(16);
  if (start) insSymbol_.bind(17, start); else insSymbol_.bindNull(17);
  if (end) insSymbol_.bind(18, end); else insSymbol_.bindNull(18);
  if (line) insSymbol_.bind(19, line); else insSymbol_.bindNull(19);
  if (definitionId) insSymbol_.bind(20, definitionId); else insSymbol_.bindNull(20);
  insSymbol_.exec();
  return id;
}

void IndexWriter::addSymbolAlias(int64_t symbolId, int64_t aliasSymbolId) {
  insSymbolAlias_.bind(1, symbolId).bind(2, aliasSymbolId).exec();
}

int64_t IndexWriter::addOccurrence(const OccurrenceRecord& r) {
  int64_t id = nextId();
  insOcc_.bind(1, id);
  if (r.bodyId) insOcc_.bind(2, r.bodyId); else insOcc_.bindNull(2);
  insOcc_.bind(3, r.sourceId).bind(4, r.startByte).bind(5, r.endByte).bind(6, r.kind)
      .bind(7, r.role).bind(8, r.status);
  if (r.targetSymbolId) insOcc_.bind(9, *r.targetSymbolId); else insOcc_.bindNull(9);
  if (r.targetInstanceId) insOcc_.bind(10, *r.targetInstanceId); else insOcc_.bindNull(10);
  if (r.targetSourceId) insOcc_.bind(11, *r.targetSourceId); else insOcc_.bindNull(11);
  if (r.targetStartByte) insOcc_.bind(12, *r.targetStartByte); else insOcc_.bindNull(12);
  if (r.targetEndByte) insOcc_.bind(13, *r.targetEndByte); else insOcc_.bindNull(13);
  if (r.targetLine) insOcc_.bind(14, *r.targetLine); else insOcc_.bindNull(14);
  if (r.targetMacroId) insOcc_.bind(15, *r.targetMacroId); else insOcc_.bindNull(15);
  if (r.targetDefinitionId) insOcc_.bind(16, *r.targetDefinitionId); else insOcc_.bindNull(16);
  if (r.detail.empty()) insOcc_.bindNull(17); else insOcc_.bind(17, r.detail);
  insOcc_.exec();
  return id;
}

int64_t IndexWriter::addMacroDefinition(std::string_view name, int64_t sourceId, int64_t start,
                                        int64_t end, int64_t line, std::string_view body) {
  int64_t id = nextId();
  insMacro_.bind(1, id).bind(2, name);
  if (sourceId) insMacro_.bind(3, sourceId); else insMacro_.bindNull(3);
  if (start) insMacro_.bind(4, start); else insMacro_.bindNull(4);
  if (end) insMacro_.bind(5, end); else insMacro_.bindNull(5);
  if (line) insMacro_.bind(6, line); else insMacro_.bindNull(6);
  if (body.empty()) insMacro_.bindNull(7); else insMacro_.bind(7, body);
  insMacro_.exec();
  return id;
}

int64_t IndexWriter::addInclude(int64_t sourceId, int64_t start, int64_t end,
                                int64_t targetSourceId, bool isSystem) {
  int64_t id = nextId();
  if (sourceId) insInclude_.bind(1, id).bind(2, sourceId); else { insInclude_.bind(1, id); insInclude_.bindNull(2); }
  if (start) insInclude_.bind(3, start); else insInclude_.bindNull(3);
  if (end) insInclude_.bind(4, end); else insInclude_.bindNull(4);
  if (targetSourceId) insInclude_.bind(5, targetSourceId); else insInclude_.bindNull(5);
  insInclude_.bind(6, int64_t(isSystem ? 1 : 0)).exec();
  return id;
}

int64_t IndexWriter::addImport(int64_t bodyId, int64_t sourceId, int64_t start, int64_t end,
                               std::string_view packageName, int64_t targetDefinitionId,
                               int64_t targetSourceId, int64_t targetStart, int64_t targetLine) {
  int64_t id = nextId();
  insImport_.bind(1, id);
  if (bodyId) insImport_.bind(2, bodyId); else insImport_.bindNull(2);
  if (sourceId) insImport_.bind(3, sourceId); else insImport_.bindNull(3);
  if (start) insImport_.bind(4, start); else insImport_.bindNull(4);
  if (end) insImport_.bind(5, end); else insImport_.bindNull(5);
  if (packageName.empty()) insImport_.bindNull(6); else insImport_.bind(6, packageName);
  if (targetDefinitionId) insImport_.bind(7, targetDefinitionId); else insImport_.bindNull(7);
  if (targetSourceId) insImport_.bind(8, targetSourceId); else insImport_.bindNull(8);
  if (targetStart) insImport_.bind(9, targetStart); else insImport_.bindNull(9);
  if (targetLine) insImport_.bind(10, targetLine); else insImport_.bindNull(10);
  insImport_.exec();
  return id;
}

int64_t IndexWriter::addMacroUse(int64_t bodyId, int64_t sourceId, int64_t start, int64_t end,
                                 int64_t definitionId) {
  int64_t id = nextId();
  insMacroUse_.bind(1, id);
  if (bodyId) insMacroUse_.bind(2, bodyId); else insMacroUse_.bindNull(2);
  if (sourceId) insMacroUse_.bind(3, sourceId); else insMacroUse_.bindNull(3);
  if (start) insMacroUse_.bind(4, start); else insMacroUse_.bindNull(4);
  if (end) insMacroUse_.bind(5, end); else insMacroUse_.bindNull(5);
  if (definitionId) insMacroUse_.bind(6, definitionId); else insMacroUse_.bindNull(6);
  insMacroUse_.exec();
  return id;
}

int64_t IndexWriter::addDriver(const DriverRecord& r) {
  int64_t id = nextId();
  insDriver_.bind(1, id);
  if (r.bodyId) insDriver_.bind(2, r.bodyId); else insDriver_.bindNull(2);
  if (r.instanceId) insDriver_.bind(3, r.instanceId); else insDriver_.bindNull(3);
  insDriver_.bind(4, r.targetSymbolId).bind(5, r.targetBitLo).bind(6, r.targetBitHi)
      .bind(7, r.kind);
  if (r.sourceSymbolId) insDriver_.bind(8, r.sourceSymbolId); else insDriver_.bindNull(8);
  if (r.sourceInstanceId) insDriver_.bind(9, r.sourceInstanceId); else insDriver_.bindNull(9);
  insDriver_.bind(10, r.sourceBitLo).bind(11, r.sourceBitHi);
  if (r.sourceId) insDriver_.bind(12, r.sourceId); else insDriver_.bindNull(12);
  if (r.startByte) insDriver_.bind(13, r.startByte); else insDriver_.bindNull(13);
  if (r.endByte) insDriver_.bind(14, r.endByte); else insDriver_.bindNull(14);
  if (r.line) insDriver_.bind(15, r.line); else insDriver_.bindNull(15);
  insDriver_.bind(16, r.exactness);
  if (r.detail.empty()) insDriver_.bindNull(17); else insDriver_.bind(17, r.detail);
  insDriver_.exec();
  return id;
}

int64_t IndexWriter::addLoad(const LoadRecord& r) {
  int64_t id = nextId();
  insLoad_.bind(1, id);
  if (r.sourceBodyId) insLoad_.bind(2, r.sourceBodyId); else insLoad_.bindNull(2);
  if (r.sourceInstanceId) insLoad_.bind(3, r.sourceInstanceId); else insLoad_.bindNull(3);
  insLoad_.bind(4, r.sourceSymbolId).bind(5, r.sourceBitLo).bind(6, r.sourceBitHi);
  if (r.targetBodyId) insLoad_.bind(7, r.targetBodyId); else insLoad_.bindNull(7);
  if (r.targetInstanceId) insLoad_.bind(8, r.targetInstanceId); else insLoad_.bindNull(8);
  insLoad_.bind(9, r.targetSymbolId).bind(10, r.targetBitLo).bind(11, r.targetBitHi)
      .bind(12, r.role).bind(13, r.exactness);
  if (r.useSourceId) insLoad_.bind(14, r.useSourceId); else insLoad_.bindNull(14);
  if (r.useStartByte) insLoad_.bind(15, r.useStartByte); else insLoad_.bindNull(15);
  if (r.useEndByte) insLoad_.bind(16, r.useEndByte); else insLoad_.bindNull(16);
  if (r.targetSourceId) insLoad_.bind(17, r.targetSourceId); else insLoad_.bindNull(17);
  if (r.targetStartByte) insLoad_.bind(18, r.targetStartByte); else insLoad_.bindNull(18);
  if (r.targetEndByte) insLoad_.bind(19, r.targetEndByte); else insLoad_.bindNull(19);
  if (r.detail.empty()) insLoad_.bindNull(20); else insLoad_.bind(20, r.detail);
  insLoad_.exec();
  return id;
}

void IndexWriter::commit() { db_.commit(); }
void IndexWriter::rollback() { db_.rollback(); }
void IndexWriter::close() { db_.close(); }

} // namespace rtl
