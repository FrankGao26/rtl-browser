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
#include <map>
#include <string>
#include <tuple>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include <slang/analysis/AnalysisManager.h>
#include <slang/ast/Compilation.h>
#include <slang/ast/Symbol.h>
#include <slang/ast/symbols/InstanceSymbols.h>
#include <slang/text/SourceManager.h>

#include "input/path_policy.h"
#include "source_store.h"
#include "store/index_writer.h"

namespace slang {
namespace syntax { class SyntaxNode; class DataTypeSyntax; class NameSyntax; class TypeAssignmentSyntax; }
namespace ast {
class Statement;
class TimingControl;
class Expression;
class AssignmentExpression;
class TypeParameterSymbol;
class PortSymbol;
class TypeAliasType;
class Type;
class DeclaredType;
class GenerateBlockSymbol;
class PackageSymbol;
enum class SymbolKind;
enum class ArgumentDirection;
enum class DefinitionKind;
} // namespace ast
namespace analysis { enum class DriverSource : uint8_t; }
} // namespace slang

namespace rtl {

struct BodyInfo {
  int64_t id = 0;
  int64_t scopeId = 0;
  int64_t parentInstanceId = 0;
  int64_t ownerInstanceId = 0;
  const slang::ast::InstanceBodySymbol* body = nullptr;
  std::unordered_map<const slang::ast::Symbol*, int64_t> symbols;
  std::unordered_map<const slang::ast::Scope*, int64_t> scopes;
};

struct OverrideTarget {
  MappedSpan span;
  int64_t parentInstanceId = 0;
};

struct ControlRef {
  int64_t symbolId = 0;
  int64_t lo = 0;
  int64_t hi = 0;
  MappedSpan span;
  std::string role;
};

class Indexer {
public:
  Indexer(slang::ast::Compilation& compilation, const slang::SourceManager& sm,
          slang::analysis::AnalysisManager& analysis, IndexWriter& writer, SourceStore& sources,
          const PathPolicy& paths);

  void run();
  int64_t rootInstanceId() const { return rootInstanceId_; }
  const std::string& rootPath() const { return rootPath_; }
  nlohmann::json counts() const;
  nlohmann::json capabilities() const;
  nlohmann::json capabilityComplete() const;

  // Used by the field/expression visitors.
  void addSymbolOccurrence(BodyInfo& body, const slang::ast::Symbol& sym,
                           slang::SourceRange range, std::string role);
  void addTypeOccurrence(BodyInfo& body, const slang::ast::Type& type,
                         slang::SourceRange range);
  void addMemberOccurrence(BodyInfo& body, const slang::ast::ValueSymbol& root,
                           slang::SourceRange memberRange, std::string memberName,
                           std::string memberValue);
  void addMemberOccurrenceAt(BodyInfo& body, const slang::ast::ValueSymbol& root,
                             const MappedSpan& memberSpan, std::string memberName,
                             std::string memberValue);
  // Fallback for expressions whose MemberAccess syntax is not retained: find
  // the member token inside the expression source range.
  void addMemberOccurrenceFromExpression(BodyInfo& body, const slang::ast::ValueSymbol& root,
                                         slang::SourceRange exprRange, std::string memberName,
                                         std::string memberValue);
  void addImportSymbol(BodyInfo& body, const slang::ast::Symbol& sym);
  void processAssignment(BodyInfo& body, const slang::ast::AssignmentExpression& expr,
                         const std::vector<ControlRef>& controls, int64_t scopeInstanceId);

private:
  slang::ast::Compilation& compilation_;
  const slang::SourceManager& sm_;
  slang::analysis::AnalysisManager& analysis_;
  IndexWriter& writer_;
  SourceStore& sources_;
  const PathPolicy& paths_;

  std::unordered_map<const slang::ast::DefinitionSymbol*, int64_t> defIds_;
  std::unordered_map<const slang::ast::PackageSymbol*, int64_t> packageBodyIds_;
  std::unordered_map<const slang::ast::InstanceBodySymbol*, BodyInfo> bodies_;
  std::unordered_map<const slang::ast::InstanceSymbol*, int64_t> instanceIds_;
  std::unordered_map<const slang::ast::Symbol*, int64_t> generateInstanceIds_;
  std::unordered_map<int64_t, std::unordered_set<std::string>> generateSiblingNames_;
  std::vector<std::pair<int64_t, const slang::ast::Symbol*>> pendingPortAliases_;
  std::unordered_map<const slang::ast::Symbol*, int64_t> symbolIds_;
  std::unordered_map<int64_t, std::string> symbolLabels_;
  std::unordered_map<int64_t, OverrideTarget> overrideTargets_;
  // Type parameters are not ValueSymbols; type references resolve to an alias
  // type whose location is the declaration. Map that location to the binding
  // expression in the parent instantiation so clicks follow the override.
  std::map<std::pair<uint32_t, uint64_t>, OverrideTarget> typeParameterOverridesByLocation_;
  // body id, buffer id, source offset -> type parameter declaration symbol
  std::map<std::tuple<int64_t, uint32_t, uint64_t>, const slang::ast::TypeParameterSymbol*>
      typeParametersByLocation_;
  std::unordered_set<std::string> occKeys_;
  std::unordered_set<std::string> driverKeys_;
  std::unordered_set<std::string> loadKeys_;
  std::unordered_set<std::string> inactiveRegionKeys_;
  std::unordered_map<const slang::ast::Symbol*, int64_t> genvarOwnerIds_;
  std::unordered_map<const slang::ast::Symbol*, int> genvarOwnerDepth_;
  std::unordered_map<const slang::syntax::SyntaxNode*, int64_t> macroDefIds_;
  std::map<std::pair<uint32_t, uint64_t>, const slang::syntax::TypeAssignmentSyntax*>
      typeAssignmentSyntaxes_;
  bool typeAssignmentSyntaxesIndexed_ = false;
  std::unordered_map<const slang::ast::InstanceBodySymbol*,
                     std::unordered_map<std::string, const slang::ast::Symbol*>>
      bodySymbolMaps_;
  int64_t rootInstanceId_ = 0;
  std::string rootPath_;
  nlohmann::json counts_ = {{"instances", 0}, {"generateScopes", 0}, {"symbols", 0},
                            {"occurrences", 0}, {"drivers", 0}, {"loads", 0}, {"sources", 0}};
  size_t unsupportedLoads_ = 0;

  MappedSpan spanOf(slang::SourceLocation loc, size_t fallbackLength = 0) const;
  MappedSpan spanOf(slang::SourceRange range, size_t fallbackLength = 0) const;
  slang::SourceLocation fileLocation(slang::SourceLocation loc) const;
  const slang::syntax::DataTypeSyntax* declaredTypeSyntaxFor(const slang::ast::Symbol& sym);
  const slang::ast::Symbol* resolveQualifiedType(const slang::syntax::NameSyntax& name,
                                                 const slang::ast::Scope& lookupScope) const;
  const OverrideTarget* overrideTargetAt(slang::SourceLocation loc) const;
  int64_t typeParameterIdFor(const BodyInfo& body, const slang::ast::Type& type) const;
  std::string textOf(const MappedSpan& span) const;
  std::string symbolKindName(slang::ast::SymbolKind kind) const;
  std::string directionName(slang::ast::ArgumentDirection dir) const;
  std::string definitionKindName(slang::ast::DefinitionKind kind) const;
  std::string driverSourceName(slang::analysis::DriverSource source) const;

  int64_t addDefinition(const slang::ast::DefinitionSymbol& def);
  int64_t addBody(const slang::ast::InstanceBodySymbol& body, int64_t definitionId,
                  int64_t parentInstanceId);
  int64_t addPackageBody(const slang::ast::PackageSymbol& package);
  void indexPackageScope(const slang::ast::PackageSymbol& package, BodyInfo& body,
                         int64_t scopeId);
  void indexScope(const slang::ast::Scope& scope, BodyInfo& body, int64_t scopeId);
  void addPortSymbol(BodyInfo& body, const slang::ast::PortSymbol& port, int64_t scopeId);
  void addValueSymbol(BodyInfo& body, const slang::ast::ValueSymbol& sym, int64_t scopeId,
                      std::string kind);
  void addTypeParameter(BodyInfo& body, const slang::ast::TypeParameterSymbol& sym,
                        int64_t scopeId);
  void addTypeAlias(BodyInfo& body, const slang::ast::TypeAliasType& type, int64_t scopeId);
  void addDeclarationOccurrence(BodyInfo& body, const slang::ast::Symbol& sym, int64_t symbolId,
                                std::string detail);
  void addDeclaredTypeOccurrences(BodyInfo& body, const slang::ast::ValueSymbol& sym);
  void addDeclaredTypeSyntax(BodyInfo& body, const slang::ast::DeclaredType& type,
                             const slang::ast::Scope& lookupScope);
  void addTypeSyntaxOccurrences(BodyInfo& body, const slang::syntax::DataTypeSyntax& syntax,
                                const slang::ast::Type& targetType,
                                const slang::ast::Scope& lookupScope);
  void addSyntaxNameRefs(BodyInfo& body, const slang::syntax::SyntaxNode& node,
                         const slang::ast::Scope& lookupScope);
  void addTypeSyntaxByName(BodyInfo& body, const slang::syntax::DataTypeSyntax& syntax,
                           const slang::ast::Scope& lookupScope);
  void addTypeDimensionRefs(BodyInfo& body, const slang::syntax::SyntaxNode& node,
                            const slang::ast::Scope& lookupScope);
  MappedSpan nameSpanOf(const slang::syntax::NameSyntax& name) const;
  void addPackageOccurrence(BodyInfo& body, const MappedSpan& span, std::string_view name);
  void addPackagePrefixOccurrence(BodyInfo& body, const MappedSpan& span, std::string_view text);
  void addTypeFieldOccurrences(BodyInfo& body, const slang::ast::Type& type,
                               const slang::ast::Scope& lookupScope);
  void addGenerateReferences(BodyInfo& body, const slang::ast::Scope& scope);
  void recordInactiveBlock(const slang::ast::GenerateBlockSymbol& block, const BodyInfo& body,
                           int64_t ownerInstanceId);
  void recordInactiveSpan(const MappedSpan& span, const BodyInfo& body, std::string_view kind,
                          int64_t ownerInstanceId);
  int64_t inactiveOwnerFor(const slang::ast::GenerateBlockSymbol& block,
                           int64_t fallbackOwnerId) const;
  int64_t lineStartOf(const MappedSpan& span) const;
  int64_t lineEndOf(const MappedSpan& span) const;
  std::string symbolPathKey(const slang::ast::Symbol& sym) const;
  const std::unordered_map<std::string, const slang::ast::Symbol*>& bodySymbolMap(
      const slang::ast::InstanceBodySymbol& body);
  void addInstance(const slang::ast::InstanceSymbol& inst, int64_t parentId, int64_t ordinal,
                   int64_t depth, bool instanceArray);
  int64_t addGenerateInstance(BodyInfo& body, const slang::ast::Symbol& sym,
                              std::string_view moduleName, int64_t parentId, int64_t ordinal,
                              int64_t depth, bool instanceArray,
                              std::string_view displayName = {});
  std::string uniqueGenerateName(int64_t parentId, std::string name);
  void collectHierarchy(const slang::ast::Scope& scope, BodyInfo& body, int64_t parentId,
                        int64_t depth, int64_t& ordinal, int64_t loopOwnerId, int loopNesting);
  int64_t scopeInstanceForSymbol(const slang::ast::Symbol& sym, int64_t fallback) const;
  int64_t scopeInstanceForInstance(const slang::ast::InstanceSymbol& inst, int64_t fallback) const;
  void addInstanceOccurrence(const slang::ast::InstanceSymbol& inst, int64_t instanceId);
  void addBodyReferences(BodyInfo& body);
  void addDrivers(BodyInfo& body);
  void addLoads(BodyInfo& body);
  void addPortEdges(const slang::ast::InstanceSymbol& inst, BodyInfo& childBody);
  void addParameterOverrideRefs(const slang::ast::InstanceSymbol& inst, BodyInfo& parentBody);
  void addPreprocessorLinks();
  void addPreprocessorRegions();
  void addGlobalPackageImports();
  void addOccurrence(BodyInfo* body, const MappedSpan& span, std::string kind, std::string role,
                     std::string status, const MappedSpan* target, std::string targetKind,
                     int64_t targetId, int64_t targetMacroId, int64_t targetDefinitionId,
                     std::string detail, int64_t targetInstanceId = 0);
  void addLoadEdge(const LoadRecord& load);
  void addDriverEdge(const DriverRecord& driver);
  void addControlPaths(BodyInfo& body, const slang::ast::Expression& expr, std::string role,
                       std::vector<ControlRef>& controls);
  void processStatement(BodyInfo& body, const slang::ast::Statement& stmt,
                        const std::vector<ControlRef>& controls, int64_t scopeInstanceId);
  void processTiming(BodyInfo& body, const slang::ast::TimingControl& timing,
                     std::vector<ControlRef>& controls);
  void processScopeAssignments(BodyInfo& body, const slang::ast::Scope& scope,
                               int64_t scopeInstanceId);
};

} // namespace rtl
