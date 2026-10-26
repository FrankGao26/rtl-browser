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

#include "indexer.h"

#include <algorithm>
#include <cctype>
#include <functional>
#include <stdexcept>
#include <unordered_map>
#include <cstdio>
#include <cstdlib>

#include <slang/analysis/ValueDriver.h>
#include <slang/ast/ASTVisitor.h>
#include <slang/ast/Compilation.h>
#include <slang/ast/EvalContext.h>
#include <slang/ast/Lookup.h>
#include <slang/ast/types/DeclaredType.h>
#include <slang/ast/Expression.h>
#include <slang/ast/TimingControl.h>
#include <slang/ast/expressions/AssignmentExpressions.h>
#include <slang/ast/expressions/MiscExpressions.h>
#include <slang/ast/expressions/SelectExpressions.h>
#include <slang/ast/statements/ConditionalStatements.h>
#include <slang/ast/statements/LoopStatements.h>
#include <slang/ast/statements/MiscStatements.h>
#include <slang/ast/symbols/BlockSymbols.h>
#include <slang/ast/symbols/CompilationUnitSymbols.h>
#include <slang/ast/symbols/InstanceSymbols.h>
#include <slang/ast/symbols/MemberSymbols.h>
#include <slang/ast/symbols/ParameterSymbols.h>
#include <slang/ast/symbols/PortSymbols.h>
#include <slang/ast/symbols/VariableSymbols.h>
#include <slang/ast/types/AllTypes.h>
#include <slang/numeric/ConstantValue.h>
#include <slang/parsing/PreprocessorMetadata.h>
#include <slang/syntax/AllSyntax.h>
#include <slang/syntax/SyntaxTree.h>
#include <slang/syntax/SyntaxVisitor.h>

namespace rtl {
namespace {

std::string cleanName(std::string_view text) {
  size_t i = 0;
  while (i < text.size() && (text[i] == '`' || std::isspace(static_cast<unsigned char>(text[i])))) i++;
  size_t j = i;
  while (j < text.size()) {
    unsigned char c = static_cast<unsigned char>(text[j]);
    if (!(std::isalnum(c) || c == '_' || c == '$')) break;
    j++;
  }
  return std::string(text.substr(i, j - i));
}

std::string macroDefinitionName(std::string_view text) {
  size_t p = text.find("define");
  if (p == std::string_view::npos) return cleanName(text);
  p += 6;
  while (p < text.size() && std::isspace(static_cast<unsigned char>(text[p]))) p++;
  size_t j = p;
  while (j < text.size()) {
    unsigned char c = static_cast<unsigned char>(text[j]);
    if (!(std::isalnum(c) || c == '_' || c == '$')) break;
    j++;
  }
  return std::string(text.substr(p, j - p));
}

struct AssignmentVisitor : slang::ast::ASTVisitor<AssignmentVisitor, slang::ast::VisitFlags::AllGood> {
  Indexer& indexer;
  BodyInfo& body;
  const std::vector<ControlRef>& controls;
  int64_t scopeInstanceId;
  AssignmentVisitor(Indexer& indexer, BodyInfo& body, const std::vector<ControlRef>& controls,
                    int64_t scopeInstanceId)
      : indexer(indexer), body(body), controls(controls), scopeInstanceId(scopeInstanceId) {}
  void handle(const slang::ast::InstanceSymbol&) {}
  void handle(const slang::ast::InstanceArraySymbol&) {}
  void handle(const slang::ast::AssignmentExpression& expr) {
    indexer.processAssignment(body, expr, controls, scopeInstanceId);
  }
};

struct RefVisitor : slang::ast::ASTVisitor<RefVisitor, slang::ast::VisitFlags::AllGood> {
  Indexer& indexer;
  BodyInfo& body;
  std::string role;
  RefVisitor(Indexer& indexer, BodyInfo& body, std::string role = "read")
      : indexer(indexer), body(body), role(std::move(role)) {}
  void handle(const slang::ast::InstanceSymbol&) {}
  void handle(const slang::ast::InstanceArraySymbol&) {}
  void handle(const slang::ast::ParameterSymbol& sym) {
    if (!sym.isOverridden()) visitDefault(sym);
  }
  void handle(const slang::ast::TypeParameterSymbol& sym) {
    if (!sym.isOverridden()) visitDefault(sym);
  }
  void handle(const slang::ast::NamedValueExpression& expr) {
    indexer.addSymbolOccurrence(body, expr.symbol, expr.sourceRange, role);
    visitDefault(expr);
  }
  void handle(const slang::ast::HierarchicalValueExpression& expr) {
    indexer.addSymbolOccurrence(body, expr.symbol, expr.sourceRange, role);
    visitDefault(expr);
  }
  static bool memberTokenRange(const slang::syntax::ExpressionSyntax& syntax,
                               slang::SourceRange& out) {
    if (syntax.kind == slang::syntax::SyntaxKind::MemberAccessExpression) {
      out = syntax.as<slang::syntax::MemberAccessExpressionSyntax>().name.range();
      return true;
    }
    if (syntax.kind == slang::syntax::SyntaxKind::ScopedName) {
      const slang::syntax::NameSyntax* name = syntax.as<slang::syntax::ScopedNameSyntax>().right;
      while (name && name->kind == slang::syntax::SyntaxKind::ScopedName)
        name = name->as<slang::syntax::ScopedNameSyntax>().right;
      if (name && name->kind == slang::syntax::SyntaxKind::IdentifierName) {
        out = name->as<slang::syntax::IdentifierNameSyntax>().identifier.range();
        return true;
      }
    }
    return false;
  }

  static const slang::ast::ValueSymbol* parameterRoot(const slang::ast::Expression& expr) {
    const slang::ast::Expression* base = &expr;
    while (base) {
      if (base->kind == slang::ast::ExpressionKind::MemberAccess)
        base = &base->as<slang::ast::MemberAccessExpression>().value();
      else if (base->kind == slang::ast::ExpressionKind::ElementSelect)
        base = &base->as<slang::ast::ElementSelectExpression>().value();
      else if (base->kind == slang::ast::ExpressionKind::RangeSelect)
        base = &base->as<slang::ast::RangeSelectExpression>().value();
      else
        break;
    }
    if (!base) return nullptr;
    const slang::ast::ValueSymbol* sym = nullptr;
    if (base->kind == slang::ast::ExpressionKind::NamedValue)
      sym = &base->as<slang::ast::NamedValueExpression>().symbol;
    else if (base->kind == slang::ast::ExpressionKind::HierarchicalValue)
      sym = &base->as<slang::ast::HierarchicalValueExpression>().symbol;
    if (!sym || sym->kind != slang::ast::SymbolKind::Parameter) return nullptr;
    return sym;
  }

  static const slang::ast::MemberAccessExpression* innermostMember(
      const slang::ast::Expression& expr) {
    if (expr.kind == slang::ast::ExpressionKind::MemberAccess)
      return &expr.as<slang::ast::MemberAccessExpression>();
    if (expr.kind == slang::ast::ExpressionKind::ElementSelect)
      return innermostMember(expr.as<slang::ast::ElementSelectExpression>().value());
    if (expr.kind == slang::ast::ExpressionKind::RangeSelect)
      return innermostMember(expr.as<slang::ast::RangeSelectExpression>().value());
    return nullptr;
  }

  void addMemberFor(const slang::ast::MemberAccessExpression& member,
                    const slang::ast::ValueSymbol& root, std::string value) {
    std::string name(member.member.name);
    slang::SourceRange range;
    if (member.syntax && memberTokenRange(*member.syntax, range)) {
      indexer.addMemberOccurrence(body, root, range, std::move(name), std::move(value));
    } else {
      indexer.addMemberOccurrenceFromExpression(body, root, member.sourceRange,
                                                std::move(name), std::move(value));
    }
  }

  void handle(const slang::ast::MemberAccessExpression& expr) {
    // `Cfg.NoSlvPorts`: create a member occurrence for the field token that
    // jumps like the root parameter but reports the evaluated member value.
    if (expr.member.kind == slang::ast::SymbolKind::Field) {
      if (const auto* root = parameterRoot(expr)) {
        std::string value;
        if (body.body) {
          try {
            slang::ast::EvalContext eval(*body.body);
            value = expr.eval(eval).toString();
          } catch (...) { /* keep name-only member info */ }
        }
        addMemberFor(expr, *root, std::move(value));
      }
    }
    visitDefault(expr);
  }

  template<typename TSelect>
  void handleSelect(const TSelect& expr) {
    if (const auto* member = innermostMember(expr.value())) {
      if (member->member.kind == slang::ast::SymbolKind::Field) {
        if (const auto* root = parameterRoot(*member)) {
          std::string value;
          bool evaluated = false;
          if (body.body) {
            try {
              slang::ast::EvalContext eval(*body.body);
              value = expr.eval(eval).toString();
              evaluated = true;
            } catch (...) { /* fall back to the member value below */ }
          }
          if (evaluated) addMemberFor(*member, *root, std::move(value));
        }
      }
    }
    visitDefault(expr);
  }

  void handle(const slang::ast::ElementSelectExpression& expr) { handleSelect(expr); }
  void handle(const slang::ast::RangeSelectExpression& expr) { handleSelect(expr); }
  void handle(const slang::ast::TypeReferenceExpression& expr) {
    indexer.addTypeOccurrence(body, expr.targetType, expr.sourceRange);
    visitDefault(expr);
  }
  void handle(const slang::ast::DataTypeExpression& expr) {
    indexer.addTypeOccurrence(body, *expr.type, expr.sourceRange);
    visitDefault(expr);
  }
  void handle(const slang::ast::ExplicitImportSymbol& sym) {
    indexer.addImportSymbol(body, sym);
  }
  void handle(const slang::ast::WildcardImportSymbol& sym) {
    indexer.addImportSymbol(body, sym);
  }
};

// Collects loop genvar parameters referenced by a generate condition so the
// inactive branch can be attributed to the iteration where it is decidable.
struct GenvarRefVisitor : slang::ast::ASTVisitor<GenvarRefVisitor, slang::ast::VisitFlags::AllGood> {
  std::vector<const slang::ast::Symbol*> refs;
  void handle(const slang::ast::NamedValueExpression& expr) {
    refs.push_back(&expr.symbol);
  }
  void handle(const slang::ast::HierarchicalValueExpression& expr) {
    refs.push_back(&expr.symbol);
  }
};

} // namespace

Indexer::Indexer(slang::ast::Compilation& compilation, const slang::SourceManager& sm,
                 slang::analysis::AnalysisManager& analysis, IndexWriter& writer,
                 SourceStore& sources, const PathPolicy& paths)
    : compilation_(compilation), sm_(sm), analysis_(analysis), writer_(writer), sources_(sources),
      paths_(paths) {}

MappedSpan Indexer::spanOf(slang::SourceLocation loc, size_t fallbackLength) const {
  if (!loc.valid()) return {};
  for (int i = 0; i < 32 && loc.valid() && (sm_.isMacroLoc(loc) || sm_.isMacroArgLoc(loc)); i++) {
    auto original = sm_.getOriginalLoc(loc);
    if (!original.valid() || original == loc) break;
    loc = original;
  }
  return sources_.mapLocation(loc, fallbackLength);
}

MappedSpan Indexer::spanOf(slang::SourceRange range, size_t fallbackLength) const {
  MappedSpan start = spanOf(range.start(), fallbackLength);
  if (!start.valid) return start;
  MappedSpan end = spanOf(range.end(), 0);
  if (end.valid && end.sourceId == start.sourceId && end.start >= start.start) start.end = end.start;
  return start;
}

int64_t Indexer::lineStartOf(const MappedSpan& span) const {
  if (!span.valid) return 0;
  SourceInfo* info = sources_.byId(span.sourceId);
  return info ? sources_.lineFor(*info, span.start) : span.line;
}

int64_t Indexer::lineEndOf(const MappedSpan& span) const {
  if (!span.valid) return 0;
  SourceInfo* info = sources_.byId(span.sourceId);
  if (!info) return span.line;
  return sources_.lineFor(*info, std::max(span.start, span.end - 1));
}

void Indexer::recordInactiveSpan(const MappedSpan& span, const BodyInfo& body,
                                 std::string_view kind, int64_t ownerInstanceId) {
  if (!span.valid || span.end <= span.start) return;
  std::string key = std::to_string(body.id) + ":" + std::to_string(ownerInstanceId) + ":" +
                    std::to_string(span.sourceId) + ":" + std::to_string(span.start) + ":" +
                    std::to_string(span.end) + ":" + std::string(kind);
  if (!inactiveRegionKeys_.insert(key).second) return;
  writer_.addInactiveRegion(body.id, ownerInstanceId, kind, "", span.sourceId, span.start,
                            span.end, lineStartOf(span), lineEndOf(span));
}

void Indexer::recordInactiveBlock(const slang::ast::GenerateBlockSymbol& block,
                                  const BodyInfo& body, int64_t ownerInstanceId) {
  const auto* syntax = block.getSyntax();
  if (!syntax) return;
  MappedSpan span = spanOf(syntax->sourceRange(), 0);
  const int64_t owner = inactiveOwnerFor(block, ownerInstanceId);
  recordInactiveSpan(span, body, slang::ast::toString(block.branchKind), owner);
}

int64_t Indexer::inactiveOwnerFor(const slang::ast::GenerateBlockSymbol& block,
                                  int64_t fallbackOwnerId) const {
  const auto* condition = block.getConditionExpression();
  if (!condition) return fallbackOwnerId;
  GenvarRefVisitor visitor;
  condition->visit(visitor);
  int bestDepth = -1;
  int64_t bestOwner = fallbackOwnerId;
  for (const auto* symbol : visitor.refs) {
    auto ownerIt = genvarOwnerIds_.find(symbol);
    if (ownerIt == genvarOwnerIds_.end()) continue;
    auto depthIt = genvarOwnerDepth_.find(symbol);
    const int depth = depthIt == genvarOwnerDepth_.end() ? 0 : depthIt->second;
    if (depth > bestDepth) {
      bestDepth = depth;
      bestOwner = ownerIt->second;
    }
  }
  return bestDepth >= 0 ? bestOwner : fallbackOwnerId;
}

slang::SourceLocation Indexer::fileLocation(slang::SourceLocation loc) const {
  for (int i = 0; i < 32 && loc.valid() && (sm_.isMacroLoc(loc) || sm_.isMacroArgLoc(loc)); i++) {
    auto original = sm_.getOriginalLoc(loc);
    if (!original.valid() || original == loc) break;
    loc = original;
  }
  return loc;
}

const slang::syntax::DataTypeSyntax* Indexer::declaredTypeSyntaxFor(
    const slang::ast::Symbol& sym) {
  // TypeParameterSymbol::getSyntax() is not populated, and for overridden
  // parameters DeclaredType follows the binding in the parent file. Index the
  // declaration-side TypeAssignmentSyntax nodes by their name token instead,
  // so that references in the default type always map to this body.
  if (!typeAssignmentSyntaxesIndexed_) {
    typeAssignmentSyntaxesIndexed_ = true;
    for (const auto& tree : compilation_.getSyntaxTrees()) {
      if (!tree) continue;
      auto visitor = slang::syntax::makeSyntaxVisitor(
          [this](auto& v, const slang::syntax::TypeAssignmentSyntax& syn) {
            auto loc = fileLocation(syn.name.location());
            if (loc.valid())
              typeAssignmentSyntaxes_[{loc.buffer().getId(), loc.offset()}] = &syn;
            v.visitDefault(syn);
          });
      tree->root().visit(visitor);
    }
  }
  auto loc = fileLocation(sym.location);
  if (!loc.valid()) return nullptr;
  auto it = typeAssignmentSyntaxes_.find({loc.buffer().getId(), loc.offset()});
  if (it == typeAssignmentSyntaxes_.end() || !it->second->assignment) return nullptr;
  return it->second->assignment->type;
}

const slang::ast::Symbol* Indexer::resolveQualifiedType(
    const slang::syntax::NameSyntax& name, const slang::ast::Scope& /*lookupScope*/) const {
  if (name.kind != slang::syntax::SyntaxKind::ScopedName) return nullptr;
  const auto& scoped = name.as<slang::syntax::ScopedNameSyntax>();
  std::string pkgName = textOf(spanOf(scoped.left->sourceRange(), 0));
  std::string memberName = textOf(nameSpanOf(*scoped.right));
  auto trim = [](std::string value) {
    while (!value.empty() && std::isspace(static_cast<unsigned char>(value.front()))) value.erase(value.begin());
    while (!value.empty() && std::isspace(static_cast<unsigned char>(value.back()))) value.pop_back();
    return value;
  };
  pkgName = trim(std::move(pkgName));
  memberName = trim(std::move(memberName));
  if (pkgName.empty() || memberName.empty()) return nullptr;
  const auto* pkg = compilation_.getPackage(pkgName);
  if (!pkg) return nullptr;
  const auto* sym = pkg->lookupName(memberName, slang::ast::LookupLocation::max,
                                    slang::ast::LookupFlags::TypeReference);
  return sym && sym->isType() ? sym : nullptr;
}

std::string Indexer::textOf(const MappedSpan& span) const {
  if (!span.valid) return {};
  SourceInfo* info = sources_.byId(span.sourceId);
  if (!info) return {};
  int64_t s = std::max<int64_t>(0, span.start);
  int64_t e = std::min<int64_t>(int64_t(info->data.size()), span.end);
  if (e <= s) return {};
  if (e - s > 8192) e = s + 8192;
  return info->data.substr(size_t(s), size_t(e - s));
}

std::string Indexer::symbolKindName(slang::ast::SymbolKind kind) const {
  using K = slang::ast::SymbolKind;
  switch (kind) {
    case K::Port: return "port";
    case K::Net: return "net";
    case K::Variable: return "variable";
    case K::FormalArgument: return "variable";
    case K::Field: return "field";
    case K::ClassProperty: return "variable";
    case K::Parameter: return "parameter";
    case K::TypeParameter: return "type_parameter";
    case K::TypeAlias: return "type_alias";
    case K::EnumValue: return "enum_value";
    case K::Specparam: return "parameter";
    default: return "symbol";
  }
}

std::string Indexer::directionName(slang::ast::ArgumentDirection dir) const {
  switch (dir) {
    case slang::ast::ArgumentDirection::In: return "input";
    case slang::ast::ArgumentDirection::Out: return "output";
    case slang::ast::ArgumentDirection::InOut: return "inout";
    case slang::ast::ArgumentDirection::Ref: return "ref";
  }
  return "";
}

std::string Indexer::definitionKindName(slang::ast::DefinitionKind kind) const {
  switch (kind) {
    case slang::ast::DefinitionKind::Module: return "module";
    case slang::ast::DefinitionKind::Interface: return "interface";
    case slang::ast::DefinitionKind::Program: return "program";
  }
  return "definition";
}

std::string Indexer::driverSourceName(slang::analysis::DriverSource source) const {
  using S = slang::analysis::DriverSource;
  switch (source) {
    case S::Initial: return "initial";
    case S::Final: return "final";
    case S::Always: return "always";
    case S::AlwaysComb: return "always_comb";
    case S::AlwaysLatch: return "always_latch";
    case S::AlwaysFF: return "always_ff";
    case S::Subroutine: return "subroutine";
    case S::Other: return "other";
  }
  return "other";
}

void Indexer::addOccurrence(BodyInfo* body, const MappedSpan& span, std::string kind,
                            std::string role, std::string status, const MappedSpan* target,
                            std::string targetKind, int64_t targetId, int64_t targetMacroId,
                            int64_t targetDefinitionId, std::string detail,
                            int64_t targetInstanceId) {
  if (!span.valid || span.sourceId == 0) return;
  std::string key = std::to_string(body ? body->id : 0) + ":" + std::to_string(span.sourceId) +
                    ":" + std::to_string(span.start) + ":" + std::to_string(span.end) + ":" +
                    kind + ":" + role + ":" + targetKind + ":" + std::to_string(targetId) + ":" +
                    std::to_string(targetMacroId) + ":" + std::to_string(targetDefinitionId) + ":" +
                    std::to_string(targetInstanceId);
  if (!occKeys_.insert(key).second) return;
  OccurrenceRecord r;
  r.bodyId = body ? body->id : 0;
  r.sourceId = span.sourceId;
  r.startByte = span.start;
  r.endByte = span.end;
  r.kind = std::move(kind);
  r.role = std::move(role);
  r.status = std::move(status);
  r.detail = std::move(detail);
  if (target && target->valid) {
    r.targetSourceId = target->sourceId;
    r.targetStartByte = target->start;
    r.targetEndByte = target->end;
    r.targetLine = target->line;
  }
  if (targetKind == "symbol" && targetId) r.targetSymbolId = targetId;
  if (targetKind == "instance" && targetId) r.targetInstanceId = targetId;
  else if (targetInstanceId) r.targetInstanceId = targetInstanceId;
  if (targetKind == "definition" && targetId) r.targetDefinitionId = targetId;
  if (targetMacroId) r.targetMacroId = targetMacroId;
  writer_.addOccurrence(r);
  counts_["occurrences"] = counts_["occurrences"].get<int64_t>() + 1;
}

void Indexer::addDeclarationOccurrence(BodyInfo& body, const slang::ast::Symbol& sym,
                                       int64_t symbolId, std::string detail) {
  MappedSpan span = spanOf(sym.location, sym.name.size());
  MappedSpan target = span;
  int64_t targetInstanceId = 0;
  if (auto it = overrideTargets_.find(symbolId); it != overrideTargets_.end()) {
    target = it->second.span;
    targetInstanceId = it->second.parentInstanceId;
  }
  addOccurrence(&body, span, "symbol", "declaration", "resolved", &target, "symbol", symbolId, 0,
                0, std::move(detail), targetInstanceId);
}

void Indexer::addSymbolOccurrence(BodyInfo& body, const slang::ast::Symbol& sym,
                                  slang::SourceRange range, std::string role) {
  auto it = symbolIds_.find(&sym);
  if (it == symbolIds_.end()) {
    // Symbols in packages (values, typedef targets, functions) are not part of
    // the instance body index, but their declaration location is still a valid
    // navigation target.
    MappedSpan span = spanOf(range, sym.name.size());
    MappedSpan target = spanOf(sym.location, sym.name.size());
    if (target.valid) {
      addOccurrence(&body, span, "symbol", std::move(role), "resolved", &target, "source", 0, 0,
                    0, paths_.sanitizeText(sym.name));
    } else {
      addOccurrence(&body, span, "symbol", std::move(role), "unsupported", nullptr, "", 0, 0, 0,
                    paths_.sanitizeText(sym.name));
    }
    addPackagePrefixOccurrence(body, spanOf(range, 0), textOf(spanOf(range, 0)));
    return;
  }
  MappedSpan target = spanOf(sym.location, sym.name.size());
  int64_t targetInstanceId = 0;
  if (auto overrideIt = overrideTargets_.find(it->second); overrideIt != overrideTargets_.end()) {
    target = overrideIt->second.span;
    targetInstanceId = overrideIt->second.parentInstanceId;
  }
  MappedSpan occurrence = spanOf(range, sym.name.size());
  addOccurrence(&body, occurrence, "symbol", std::move(role), "resolved",
                &target, "symbol", it->second, 0, 0, symbolLabels_[it->second], targetInstanceId);
  addPackagePrefixOccurrence(body, spanOf(range, 0), textOf(spanOf(range, 0)));
}

void Indexer::addTypeOccurrence(BodyInfo& body, const slang::ast::Type& type,
                                slang::SourceRange range) {
  MappedSpan occurrence = spanOf(range, type.name.size());
  MappedSpan target = spanOf(type.location, type.name.size());
  int64_t targetInstanceId = 0;
  if (const OverrideTarget* overrideTarget = overrideTargetAt(type.location)) {
    target = overrideTarget->span;
    targetInstanceId = overrideTarget->parentInstanceId;
  }
  const int64_t targetSymbolId = typeParameterIdFor(body, type);
  if (!target.valid) {
    addOccurrence(&body, occurrence, "type", "type", "unsupported", nullptr,
                  "", 0, 0, 0, paths_.sanitizeText(type.name));
  } else {
    addOccurrence(&body, occurrence, "type", "type", "resolved", &target,
                  targetSymbolId ? "symbol" : "source", targetSymbolId, 0, 0,
                  paths_.sanitizeText(type.name), targetInstanceId);
  }
  addPackagePrefixOccurrence(body, spanOf(range, 0), textOf(spanOf(range, 0)));
}

void Indexer::addMemberOccurrence(BodyInfo& body, const slang::ast::ValueSymbol& root,
                                  slang::SourceRange memberRange, std::string memberName,
                                  std::string memberValue) {
  addMemberOccurrenceAt(body, root, spanOf(memberRange, memberName.size()),
                        std::move(memberName), std::move(memberValue));
}

void Indexer::addMemberOccurrenceFromExpression(BodyInfo& body,
                                                const slang::ast::ValueSymbol& root,
                                                slang::SourceRange exprRange,
                                                std::string memberName,
                                                std::string memberValue) {
  MappedSpan full = spanOf(exprRange, 0);
  if (!full.valid || memberName.empty()) return;
  std::string text = textOf(full);
  size_t pos = text.rfind(memberName);
  size_t use = std::string::npos;
  while (pos != std::string::npos) {
    size_t p = pos;
    while (p > 0 && std::isspace(static_cast<unsigned char>(text[p - 1]))) p--;
    if (p > 0 && text[p - 1] == '.') { use = pos; break; }
    if (pos == 0) break;
    pos = text.rfind(memberName, pos - 1);
  }
  if (use == std::string::npos) use = text.rfind(memberName);
  if (use == std::string::npos) return;
  MappedSpan memberSpan = full;
  memberSpan.start = full.start + int64_t(use);
  memberSpan.end = memberSpan.start + int64_t(memberName.size());
  addMemberOccurrenceAt(body, root, memberSpan, std::move(memberName), std::move(memberValue));
}

void Indexer::addMemberOccurrenceAt(BodyInfo& body, const slang::ast::ValueSymbol& root,
                                    const MappedSpan& memberSpan, std::string memberName,
                                    std::string memberValue) {
  MappedSpan target = spanOf(root.location, root.name.size());
  if (!memberSpan.valid || !target.valid) return;
  int64_t symbolId = 0;
  int64_t targetInstanceId = 0;
  std::string targetKind = "source";
  if (auto it = symbolIds_.find(&root); it != symbolIds_.end()) {
    symbolId = it->second;
    targetKind = "symbol";
    if (auto overrideIt = overrideTargets_.find(symbolId); overrideIt != overrideTargets_.end()) {
      target = overrideIt->second.span;
      targetInstanceId = overrideIt->second.parentInstanceId;
    }
  }
  std::string detail = std::move(memberName);
  if (!memberValue.empty()) detail += " = " + memberValue;
  addOccurrence(&body, memberSpan, "member", "read", "resolved", &target, targetKind,
                symbolId, 0, 0, detail, targetInstanceId);
}

void Indexer::addPackageOccurrence(BodyInfo& body, const MappedSpan& span,
                                    std::string_view name) {
  if (!span.valid || name.empty()) return;
  const auto* package = compilation_.getPackage(name);
  MappedSpan target = package ? spanOf(package->location, package->name.size()) : MappedSpan{};
  addOccurrence(&body, span, "package", "package", package ? "resolved" : "ambiguous",
                target.valid ? &target : nullptr, "source", 0, 0, 0,
                paths_.sanitizeText(name));
}

void Indexer::addPackagePrefixOccurrence(BodyInfo& body, const MappedSpan& span,
                                          std::string_view text) {
  if (!span.valid) return;
  size_t sep = text.find("::");
  if (sep == std::string_view::npos) return;
  std::string name(text.substr(0, sep));
  while (!name.empty() && std::isspace(static_cast<unsigned char>(name.back()))) name.pop_back();
  while (!name.empty() && std::isspace(static_cast<unsigned char>(name.front()))) name.erase(name.begin());
  if (name.empty()) return;
  MappedSpan prefix = span;
  prefix.end = span.start + int64_t(sep);
  while (prefix.end > prefix.start && text[size_t(prefix.end - span.start - 1)] == ' ') prefix.end--;
  addPackageOccurrence(body, prefix, name);
}

void Indexer::addImportSymbol(BodyInfo& body, const slang::ast::Symbol& sym) {
  const auto* syntax = sym.getSyntax();
  if (!syntax || syntax->kind != slang::syntax::SyntaxKind::PackageImportItem) {
    // Fallback for unusual import forms: keep a single package-wide span.
    MappedSpan span = spanOf(sym.location, sym.name.size());
    if (!span.valid) return;
    if (sym.kind == slang::ast::SymbolKind::WildcardImport) {
      const auto& imp = sym.as<slang::ast::WildcardImportSymbol>();
      addPackageOccurrence(body, span, imp.packageName);
    }
    return;
  }
  const auto& item = syntax->as<slang::syntax::PackageImportItemSyntax>();
  MappedSpan packageSpan = spanOf(item.package.range(), item.package.valueText().size());
  addPackageOccurrence(body, packageSpan, item.package.valueText());
  if (sym.kind == slang::ast::SymbolKind::ExplicitImport) {
    const auto& imp = sym.as<slang::ast::ExplicitImportSymbol>();
    const slang::ast::Symbol* targetSym = imp.importedSymbol();
    MappedSpan target = targetSym ? spanOf(targetSym->location, targetSym->name.size()) : MappedSpan{};
    MappedSpan span = spanOf(item.item.range(), item.item.valueText().size());
    addOccurrence(&body, span, "import", "import", targetSym ? "resolved" : "ambiguous",
                  target.valid ? &target : nullptr, "source", 0, 0, 0,
                  std::string(imp.packageName) + "::" + std::string(imp.importName));
    writer_.addImport(body.id, packageSpan.valid ? packageSpan.sourceId : 0,
                      packageSpan.valid ? packageSpan.start : 0,
                      packageSpan.valid ? packageSpan.end : 0, imp.packageName, 0,
                      target.valid ? target.sourceId : 0, target.valid ? target.start : 0,
                      target.valid ? target.line : 0);
  } else if (sym.kind == slang::ast::SymbolKind::WildcardImport) {
    const auto& imp = sym.as<slang::ast::WildcardImportSymbol>();
    const auto* pkg = imp.getPackage();
    MappedSpan target = pkg ? spanOf(pkg->location, pkg->name.size()) : MappedSpan{};
    writer_.addImport(body.id, packageSpan.valid ? packageSpan.sourceId : 0,
                      packageSpan.valid ? packageSpan.start : 0,
                      packageSpan.valid ? packageSpan.end : 0, imp.packageName, 0,
                      target.valid ? target.sourceId : 0, target.valid ? target.start : 0,
                      target.valid ? target.line : 0);
  }
}

int64_t Indexer::addDefinition(const slang::ast::DefinitionSymbol& def) {
  auto it = defIds_.find(&def);
  if (it != defIds_.end()) return it->second;
  MappedSpan span = spanOf(def.location, def.name.size());
  std::string kind = definitionKindName(def.definitionKind);
  int64_t id = writer_.addDefinition(kind, def.name, def.name,
                                     span.valid ? span.sourceId : 0, span.valid ? span.start : 0,
                                     span.valid ? span.end : 0, span.valid ? span.line : 0, 0);
  // Keep the full declaration extent (module ... endmodule) separate from the
  // name token so the source view can gray out other definitions in the same
  // file without changing definition-jump locations.
  if (const auto* syntax = def.getSyntax()) {
    MappedSpan full = spanOf(syntax->sourceRange(), 0);
    if (full.valid && full.end > full.start) {
      writer_.addSourceScope(id, kind, def.name, full.sourceId, full.start, full.end,
                             lineStartOf(full), lineEndOf(full));
    }
  }
  defIds_[&def] = id;
  return id;
}

int64_t Indexer::addBody(const slang::ast::InstanceBodySymbol& body, int64_t definitionId,
                         int64_t parentInstanceId) {
  auto it = bodies_.find(&body);
  if (it != bodies_.end()) return it->second.id;

  std::string sig;
  for (const auto* p : body.getParameters()) {
    if (!sig.empty()) sig += ";";
    sig += std::string(p->symbol.name);
    sig += "=";
    if (p->symbol.kind == slang::ast::SymbolKind::Parameter) {
      sig += p->symbol.as<slang::ast::ParameterSymbol>().getValue().toString();
    } else if (p->symbol.kind == slang::ast::SymbolKind::TypeParameter) {
      sig += p->symbol.as<slang::ast::TypeParameterSymbol>().targetType.getType().toString();
    }
  }
  int64_t bodyId = writer_.addBody(definitionId, body.getDefinition().name, sig, 0);
  int64_t scopeId = writer_.addScope(0, "module", body.getDefinition().name, definitionId);
  BodyInfo info;
  info.id = bodyId;
  info.scopeId = scopeId;
  info.parentInstanceId = parentInstanceId;
  info.body = &body;
  auto [inserted, ok] = bodies_.emplace(&body, std::move(info));
  (void)ok;
  // Register overridden type parameters before indexing members so type
  // references can navigate to the parent instantiation binding.
  for (const auto* p : body.getParameters()) {
    if (!p || p->symbol.kind != slang::ast::SymbolKind::TypeParameter) continue;
    const auto& tp = p->symbol.as<slang::ast::TypeParameterSymbol>();
    slang::SourceLocation loc = fileLocation(tp.location);
    if (loc.valid()) {
      typeParametersByLocation_[{bodyId, loc.buffer().getId(), loc.offset()}] = &tp;
    }
    if (!tp.isOverridden()) continue;
    const auto* syntax = tp.targetType.getTypeSyntax();
    if (!syntax) syntax = tp.targetType.getResolvedTypeSyntax();
    if (!syntax) continue;
    MappedSpan target = spanOf(syntax->sourceRange(), 0);
    if (!target.valid || !loc.valid()) continue;
    typeParameterOverridesByLocation_[{loc.buffer().getId(), loc.offset()}] =
        OverrideTarget{target, parentInstanceId};
  }
  indexScope(body, inserted->second, scopeId);
  return bodyId;
}

const OverrideTarget* Indexer::overrideTargetAt(slang::SourceLocation loc) const {
  loc = fileLocation(loc);
  if (!loc.valid()) return nullptr;
  auto it = typeParameterOverridesByLocation_.find({loc.buffer().getId(), loc.offset()});
  return it == typeParameterOverridesByLocation_.end() ? nullptr : &it->second;
}

int64_t Indexer::typeParameterIdFor(const BodyInfo& body, const slang::ast::Type& type) const {
  slang::SourceLocation loc = fileLocation(type.location);
  if (!loc.valid()) return 0;
  auto it = typeParametersByLocation_.find({body.id, loc.buffer().getId(), loc.offset()});
  if (it == typeParametersByLocation_.end()) return 0;
  auto sit = symbolIds_.find(it->second);
  return sit == symbolIds_.end() ? 0 : sit->second;
}

void Indexer::addPortSymbol(BodyInfo& body, const slang::ast::PortSymbol& port, int64_t scopeId) {
  if (port.isNullPort || port.name.empty()) return;
  if (symbolIds_.count(&port)) return;
  MappedSpan span = spanOf(port.location, port.name.size());
  const auto& type = port.getType();
  std::string typeText = type.toString();
  std::string dir = directionName(port.direction);
  int64_t id = writer_.addSymbol(
      body.id, scopeId, 0, port.name, "port", typeText, typeText,
      std::optional<int64_t>(type.getBitWidth()), std::optional<bool>(type.isSigned()), "", "",
      dir, "", "", span.valid ? span.sourceId : 0, span.valid ? span.start : 0,
      span.valid ? span.end : 0, span.valid ? span.line : 0, 0);
  symbolIds_[&port] = id;
  body.symbols[&port] = id;
  symbolLabels_[id] = dir + " " + typeText + " " + std::string(port.name);
  counts_["symbols"] = counts_["symbols"].get<int64_t>() + 1;
  addDeclarationOccurrence(body, port, id, symbolLabels_[id]);
  if (const auto* internal = port.internalSymbol) {
    if (const auto* value = internal->as_if<slang::ast::ValueSymbol>()) {
      pendingPortAliases_.emplace_back(id, internal);
      addDeclaredTypeOccurrences(body, *value);
    }
  }
}

void Indexer::addValueSymbol(BodyInfo& body, const slang::ast::ValueSymbol& sym, int64_t scopeId,
                             std::string kind) {
  if (symbolIds_.count(&sym)) return;
  const auto& type = sym.getType();
  std::string typeText = type.toString();
  std::string dir;
  if (auto* backref = sym.getFirstPortBackref()) dir = directionName(backref->port->direction);
  std::string defaultValue;
  std::string actualValue;
  if (sym.kind == slang::ast::SymbolKind::Parameter) {
    const auto& p = sym.as<slang::ast::ParameterSymbol>();
    actualValue = p.getValue().toString();
    if (p.defaultValSyntax) {
      MappedSpan s = spanOf(p.defaultValSyntax->sourceRange(), 0);
      defaultValue = textOf(s);
      size_t eq = defaultValue.find('=');
      if (eq != std::string::npos) {
        defaultValue = defaultValue.substr(eq + 1);
        while (!defaultValue.empty() && std::isspace(static_cast<unsigned char>(defaultValue.front()))) defaultValue.erase(defaultValue.begin());
        while (!defaultValue.empty() && std::isspace(static_cast<unsigned char>(defaultValue.back()))) defaultValue.pop_back();
      }
    }
    if (defaultValue.empty()) defaultValue = actualValue;
  } else if (sym.kind == slang::ast::SymbolKind::EnumValue) {
    actualValue = sym.as<slang::ast::EnumValueSymbol>().getValue().toString();
  }
  MappedSpan span = spanOf(sym.location, sym.name.size());
  int64_t id = writer_.addSymbol(
      body.id, scopeId, 0, sym.name, kind, typeText, typeText,
      std::optional<int64_t>(type.getBitWidth()), std::optional<bool>(type.isSigned()), "", "",
      dir, defaultValue, actualValue, span.valid ? span.sourceId : 0, span.valid ? span.start : 0,
      span.valid ? span.end : 0, span.valid ? span.line : 0, 0);
  symbolIds_[&sym] = id;
  body.symbols[&sym] = id;
  symbolLabels_[id] = (dir.empty() ? "" : dir + " ") + typeText + " " + std::string(sym.name);
  counts_["symbols"] = counts_["symbols"].get<int64_t>() + 1;
  if (sym.kind == slang::ast::SymbolKind::Parameter) {
    const auto& param = sym.as<slang::ast::ParameterSymbol>();
    if (param.isOverridden()) {
      const auto dt = param.getDeclaredType();
      MappedSpan target;
      if (const auto* syn = dt->getInitializerSyntax()) target = spanOf(syn->sourceRange(), 0);
      else if (const auto* init = dt->getInitializer()) target = spanOf(init->sourceRange, 0);
      if (target.valid) overrideTargets_[id] = OverrideTarget{target, body.parentInstanceId};
    }
  }
  addDeclarationOccurrence(body, sym, id, symbolLabels_[id]);
  addDeclaredTypeOccurrences(body, sym);
}

MappedSpan Indexer::nameSpanOf(const slang::syntax::NameSyntax& name) const {
  // NameSyntax can be a scoped name or an identifier with selectors. Use the
  // source text so that a selected type (`rule_t [W-1:0]`) yields only the
  // identifier span, and `pkg::type` yields the final identifier.
  MappedSpan full = spanOf(name.sourceRange(), 0);
  if (!full.valid) return full;
  std::string text = textOf(full);
  if (text.empty()) return full;
  size_t begin = 0;
  size_t sep = text.rfind("::");
  if (sep != std::string::npos) begin = sep + 2;
  while (begin < text.size() && std::isspace(static_cast<unsigned char>(text[begin]))) begin++;
  size_t end = begin;
  if (end < text.size() && text[end] == '\\') {
    end++;
    while (end < text.size() && !std::isspace(static_cast<unsigned char>(text[end]))) end++;
  } else {
    while (end < text.size()) {
      unsigned char c = static_cast<unsigned char>(text[end]);
      if (!(std::isalnum(c) || c == '_' || c == '$')) break;
      end++;
    }
  }
  if (end <= begin) return full;
  MappedSpan out = full;
  out.start = full.start + int64_t(begin);
  out.end = full.start + int64_t(end);
  return out;
}

void Indexer::addTypeSyntaxByName(BodyInfo& body, const slang::syntax::DataTypeSyntax& syntax,
                                   const slang::ast::Scope& lookupScope) {
  if ((syntax.kind == slang::syntax::SyntaxKind::StructType || syntax.kind == slang::syntax::SyntaxKind::UnionType)) {
    const auto& st = syntax.as<slang::syntax::StructUnionTypeSyntax>();
    for (const auto* member : st.members) {
      if (member && member->type) addTypeSyntaxByName(body, *member->type, lookupScope);
    }
    return;
  }
  if (syntax.kind != slang::syntax::SyntaxKind::NamedType) return;
  const auto& named = syntax.as<slang::syntax::NamedTypeSyntax>();
  MappedSpan nameSpan = nameSpanOf(*named.name);
  const std::string text = textOf(nameSpan);
  if (text.empty()) return;
  const slang::ast::Symbol* sym = lookupScope.lookupName(text, slang::ast::LookupLocation::max,
                                                         slang::ast::LookupFlags::TypeReference);
  if (!sym || !sym->isType()) sym = resolveQualifiedType(*named.name, lookupScope);
  if (!sym || !sym->isType()) return;
  MappedSpan target = spanOf(sym->location, sym->name.size());
  int64_t targetInstanceId = 0;
  if (const OverrideTarget* overrideTarget = overrideTargetAt(sym->location)) {
    target = overrideTarget->span;
    targetInstanceId = overrideTarget->parentInstanceId;
  }
  int64_t targetSymbolId = 0;
  if (auto it = symbolIds_.find(sym); it != symbolIds_.end()) targetSymbolId = it->second;
  if (nameSpan.valid && target.valid) {
    addOccurrence(&body, nameSpan, "type", "type", "resolved", &target,
                  targetSymbolId ? "symbol" : "source", targetSymbolId, 0, 0,
                  paths_.sanitizeText(sym->name), targetInstanceId);
  }
  addPackagePrefixOccurrence(body, spanOf(named.name->sourceRange(), 0),
                              textOf(spanOf(named.name->sourceRange(), 0)));
  addSyntaxNameRefs(body, *named.name, lookupScope);
}

void Indexer::addTypeDimensionRefs(BodyInfo& body, const slang::syntax::SyntaxNode& node,
                                   const slang::ast::Scope& lookupScope) {
  if (node.kind == slang::syntax::SyntaxKind::VariableDimension) {
    const auto& dim = node.as<slang::syntax::VariableDimensionSyntax>();
    if (dim.specifier) addSyntaxNameRefs(body, *dim.specifier, lookupScope);
    return;
  }
  for (size_t i = 0, n = node.getChildCount(); i < n; i++) {
    if (const auto* child = node.childNode(i)) addTypeDimensionRefs(body, *child, lookupScope);
  }
}

void Indexer::addTypeSyntaxOccurrences(BodyInfo& body, const slang::syntax::DataTypeSyntax& syntax,
                                       const slang::ast::Type& targetType,
                                       const slang::ast::Scope& lookupScope) {
  if ((syntax.kind == slang::syntax::SyntaxKind::StructType || syntax.kind == slang::syntax::SyntaxKind::UnionType)) {
    const auto& st = syntax.as<slang::syntax::StructUnionTypeSyntax>();
    for (const auto* member : st.members) {
      if (member && member->type) addTypeSyntaxByName(body, *member->type, lookupScope);
    }
    return;
  }
  if (syntax.kind != slang::syntax::SyntaxKind::NamedType) return;
  const auto& named = syntax.as<slang::syntax::NamedTypeSyntax>();
  MappedSpan nameSpan = nameSpanOf(*named.name);
  MappedSpan target = spanOf(targetType.location, targetType.name.size());
  if (!target.valid) {
    const std::string text = textOf(nameSpan);
    if (!text.empty()) {
      const auto* sym = lookupScope.lookupName(text, slang::ast::LookupLocation::max,
                                               slang::ast::LookupFlags::TypeReference);
      if (sym && sym->isType()) target = spanOf(sym->location, sym->name.size());
    }
    if (!target.valid) {
      if (const auto* sym = resolveQualifiedType(*named.name, lookupScope)) {
        target = spanOf(sym->location, sym->name.size());
      }
    }
  }
  int64_t targetInstanceId = 0;
  if (const OverrideTarget* overrideTarget = overrideTargetAt(targetType.location)) {
    target = overrideTarget->span;
    targetInstanceId = overrideTarget->parentInstanceId;
  }
  const int64_t targetSymbolId = typeParameterIdFor(body, targetType);
  if (nameSpan.valid && target.valid) {
    addOccurrence(&body, nameSpan, "type", "type", "resolved", &target,
                  targetSymbolId ? "symbol" : "source", targetSymbolId, 0, 0,
                  paths_.sanitizeText(targetType.name), targetInstanceId);
  }
  addPackagePrefixOccurrence(body, spanOf(named.name->sourceRange(), 0),
                              textOf(spanOf(named.name->sourceRange(), 0)));
  // Dimensions of a named type (`rule_t [NoRules-1:0]`) contain value
  // references that are not represented by the resolved Type object.
  addSyntaxNameRefs(body, *named.name, lookupScope);
}

void Indexer::addSyntaxNameRefs(BodyInfo& body, const slang::syntax::SyntaxNode& node,
                                const slang::ast::Scope& lookupScope) {
  MappedSpan span = spanOf(node.sourceRange(), 0);
  if (!span.valid) return;
  std::string text = textOf(span);
  for (size_t i = 0; i < text.size();) {
    unsigned char c = static_cast<unsigned char>(text[i]);
    if (!(std::isalpha(c) || c == '_' || c == '$')) { i++; continue; }
    size_t j = i + 1;
    while (j < text.size()) {
      unsigned char d = static_cast<unsigned char>(text[j]);
      if (!(std::isalnum(d) || d == '_' || d == '$')) break;
      j++;
    }
    std::string name = text.substr(i, j - i);
    const auto* sym = lookupScope.lookupName(name, slang::ast::LookupLocation::max,
                                             slang::ast::LookupFlags::None);
    if (sym && slang::ast::ValueSymbol::isKind(sym->kind)) {
      auto it = symbolIds_.find(sym);
      if (it != symbolIds_.end()) {
        MappedSpan occurrence = span;
        occurrence.start = span.start + int64_t(i);
        occurrence.end = span.start + int64_t(j);
        MappedSpan target = spanOf(sym->location, sym->name.size());
        int64_t targetInstanceId = 0;
        if (auto overrideIt = overrideTargets_.find(it->second);
            overrideIt != overrideTargets_.end()) {
          target = overrideIt->second.span;
          targetInstanceId = overrideIt->second.parentInstanceId;
        }
        if (target.valid) {
          addOccurrence(&body, occurrence, "symbol", "read", "resolved", &target, "symbol",
                        it->second, 0, 0, symbolLabels_[it->second], targetInstanceId);
        }
      }
    }

    // Type dimensions are scanned from syntax (rather than the resolved AST),
    // so handle `Cfg.NoSlvPorts` chains here: the root token stays a normal
    // parameter reference and each field gets a member occurrence with the
    // evaluated packed-struct value where it can be computed.
    size_t cursor = j;
    if (sym && sym->kind == slang::ast::SymbolKind::Parameter) {
      const auto* chainType = &sym->as<slang::ast::ValueSymbol>().getType();
      slang::ConstantValue rootValue;
      bool hasRootValue = false;
      try {
        rootValue = sym->as<slang::ast::ParameterSymbol>().getValue();
        hasRootValue = rootValue.isInteger();
      } catch (...) { hasRootValue = false; }
      uint64_t bitOffset = 0;
      while (chainType) {
        size_t k = cursor;
        while (k < text.size() && std::isspace(static_cast<unsigned char>(text[k]))) k++;
        if (k >= text.size() || text[k] != '.') break;
        size_t a = k + 1;
        while (a < text.size() && std::isspace(static_cast<unsigned char>(text[a]))) a++;
        size_t b = a;
        while (b < text.size()) {
          unsigned char d = static_cast<unsigned char>(text[b]);
          if (!(std::isalnum(d) || d == '_' || d == '$')) break;
          b++;
        }
        if (b <= a) break;
        std::string memberName = text.substr(a, b - a);
        const auto& canonical = chainType->getCanonicalType();
        if (canonical.kind != slang::ast::SymbolKind::PackedStructType &&
            canonical.kind != slang::ast::SymbolKind::UnpackedStructType) break;
        const slang::ast::Symbol* fieldSym = canonical.as<slang::ast::Scope>().lookupName(
            memberName, slang::ast::LookupLocation::max, slang::ast::LookupFlags::None);
        if (!fieldSym || fieldSym->kind != slang::ast::SymbolKind::Field) break;
        const auto& field = fieldSym->as<slang::ast::FieldSymbol>();
        bool packed = canonical.kind == slang::ast::SymbolKind::PackedStructType;
        if (packed) bitOffset += field.bitOffset;
        std::string memberValue;
        if (hasRootValue && packed) {
          try {
            uint64_t width = field.getType().getBitWidth();
            if (width > 0 && bitOffset <= INT32_MAX && width <= INT32_MAX &&
                bitOffset + width - 1 <= INT32_MAX) {
              slang::ConstantValue slice = rootValue.getSlice(
                  int32_t(bitOffset + width - 1), int32_t(bitOffset), slang::ConstantValue());
              memberValue = slice.toString();
            }
          } catch (...) { /* keep name-only member info */ }
        }
        MappedSpan memberSpan = span;
        memberSpan.start = span.start + int64_t(a);
        memberSpan.end = span.start + int64_t(b);
        addMemberOccurrenceAt(body, sym->as<slang::ast::ValueSymbol>(), memberSpan,
                              memberName, std::move(memberValue));
        chainType = &field.getType();
        cursor = b;
      }
    }
    i = cursor > j ? cursor : j;
  }
}

void Indexer::addDeclaredTypeSyntax(BodyInfo& body, const slang::ast::DeclaredType& declared,
                                    const slang::ast::Scope& lookupScope) {
  const auto* typeSyntax = declared.getTypeSyntax();
  if (!typeSyntax) return;
  addTypeSyntaxOccurrences(body, *typeSyntax, declared.getType(), lookupScope);
  for (const auto& dim : declared.getResolvedDimensions()) {
    RefVisitor visitor(*this, body, "read");
    if (dim.leftExpr) dim.leftExpr->visit(visitor);
    if (dim.rightExpr) dim.rightExpr->visit(visitor);
  }
}

void Indexer::addTypeFieldOccurrences(BodyInfo& body, const slang::ast::Type& type,
                                      const slang::ast::Scope& lookupScope) {
  const auto& canonical = type.getCanonicalType();
  const slang::ast::Scope* structScope = nullptr;
  if (canonical.kind == slang::ast::SymbolKind::PackedStructType ||
      canonical.kind == slang::ast::SymbolKind::UnpackedStructType)
    structScope = &canonical.as<slang::ast::Scope>();
  if (!structScope) return;
  for (const auto& member : structScope->members()) {
    if (member.kind != slang::ast::SymbolKind::Field) continue;
    const auto& field = member.as<slang::ast::FieldSymbol>();
    const auto dt = field.getDeclaredType();
    if (!dt) continue;
    const auto* fieldSyntax = field.getSyntax();
    if (fieldSyntax && fieldSyntax->kind == slang::syntax::SyntaxKind::StructUnionMember) {
      const auto& memberSyntax = fieldSyntax->as<slang::syntax::StructUnionMemberSyntax>();
      addTypeSyntaxOccurrences(body, *memberSyntax.type, dt->getType(), *field.getParentScope());
    }
    addTypeFieldOccurrences(body, dt->getType(), *field.getParentScope());
  }
}

void Indexer::addDeclaredTypeOccurrences(BodyInfo& body, const slang::ast::ValueSymbol& sym) {
  const auto dt = sym.getDeclaredType();
  if (!dt) return;
  const auto* scope = sym.getParentScope();
  if (!scope) return;
  addDeclaredTypeSyntax(body, *dt, *scope);
  addTypeFieldOccurrences(body, dt->getType(), *scope);
}

void Indexer::addTypeParameter(BodyInfo& body, const slang::ast::TypeParameterSymbol& sym,
                               int64_t scopeId) {
  if (symbolIds_.count(&sym)) return;
  MappedSpan span = spanOf(sym.location, sym.name.size());
  std::string aliasText;
  try { aliasText = sym.getTypeAlias().toString(); } catch (...) { aliasText = ""; }
  auto trim = [](std::string value) {
    while (!value.empty() && std::isspace(static_cast<unsigned char>(value.front()))) value.erase(value.begin());
    while (!value.empty() && std::isspace(static_cast<unsigned char>(value.back()))) value.pop_back();
    return value;
  };
  std::string defaultValue;
  bool defaultValid = false;
  if (const auto* declaredSyntax = declaredTypeSyntaxFor(sym)) {
    MappedSpan declaredSpan = spanOf(declaredSyntax->sourceRange(), 0);
    if (declaredSpan.valid) {
      defaultValue = trim(textOf(declaredSpan));
      defaultValid = !defaultValue.empty();
    }
  }
  if (!defaultValid) {
    try { defaultValue = trim(sym.targetType.getType().toString()); } catch (...) { defaultValue = aliasText; }
  }
  std::string actualValue = defaultValue;
  MappedSpan overrideTarget;
  if (sym.isOverridden()) {
    // DeclaredType::getTypeSyntax points at the parent instantiation's type
    // assignment expression (e.g. `.slv_aw_chan_t ( pkg::slv_aw_chan_t )`).
    if (const auto* overrideSyntax = sym.targetType.getTypeSyntax()) {
      MappedSpan candidate = spanOf(overrideSyntax->sourceRange(), 0);
      if (candidate.valid) {
        overrideTarget = candidate;
        std::string text = trim(textOf(candidate));
        if (!text.empty()) actualValue = std::move(text);
      }
    }
    if (actualValue == defaultValue) {
      try {
        std::string resolved = trim(sym.targetType.getType().toString());
        if (!resolved.empty()) actualValue = std::move(resolved);
      } catch (...) { /* keep default */ }
    }
  }
  const std::string typeText = aliasText.empty() ? actualValue : aliasText;
  int64_t id = writer_.addSymbol(
      body.id, scopeId, 0, sym.name, "type_parameter", defaultValue, actualValue, std::nullopt,
      std::nullopt, "", "", "", defaultValue, actualValue, span.valid ? span.sourceId : 0,
      span.valid ? span.start : 0, span.valid ? span.end : 0, span.valid ? span.line : 0, 0);
  symbolIds_[&sym] = id;
  body.symbols[&sym] = id;
  symbolLabels_[id] = "type_parameter " + typeText + " " + std::string(sym.name);
  counts_["symbols"] = counts_["symbols"].get<int64_t>() + 1;
  if (overrideTarget.valid) {
    overrideTargets_[id] = OverrideTarget{overrideTarget, body.parentInstanceId};
  }
  addDeclarationOccurrence(body, sym, id, symbolLabels_[id]);
  const auto* scope = sym.getParentScope();
  if (!scope) return;
  // The declared default type is what the source at the declaration site
  // spells, and it stays valid even when an instantiation overrides the
  // parameter. `sym.targetType` instead follows the override and its syntax
  // can live in the parent file, so never use it for occurrence extraction
  // in the child body.
  if (const auto* declaredSyntax = declaredTypeSyntaxFor(sym)) {
    addTypeSyntaxByName(body, *declaredSyntax, *scope);
    addTypeDimensionRefs(body, *declaredSyntax, *scope);
  }
  if (!sym.isOverridden()) {
    addDeclaredTypeSyntax(body, sym.targetType, *scope);
    addTypeFieldOccurrences(body, sym.targetType.getType(), *scope);
  }
}

void Indexer::addTypeAlias(BodyInfo& body, const slang::ast::TypeAliasType& type,
                           int64_t scopeId) {
  if (symbolIds_.count(&type)) return;
  MappedSpan span = spanOf(type.location, type.name.size());
  std::string target;
  try { target = type.targetType.getType().toString(); } catch (...) { target = ""; }
  int64_t id = writer_.addSymbol(
      body.id, scopeId, 0, type.name, "type_alias", target, target, std::nullopt, std::nullopt,
      "", "", "", "", "", span.valid ? span.sourceId : 0, span.valid ? span.start : 0,
      span.valid ? span.end : 0, span.valid ? span.line : 0, 0);
  symbolIds_[&type] = id;
  body.symbols[&type] = id;
  symbolLabels_[id] = "type_alias " + target + " " + std::string(type.name);
  counts_["symbols"] = counts_["symbols"].get<int64_t>() + 1;
  addDeclarationOccurrence(body, type, id, symbolLabels_[id]);
  // A typedef body is not an expression the AST visitor reaches. Scan its
  // declared type syntax so package/module-local struct fields that reference
  // other typedefs remain navigable.
  if (const auto* scope = type.getParentScope()) {
    addDeclaredTypeSyntax(body, type.targetType, *scope);
  }
}

int64_t Indexer::addPackageBody(const slang::ast::PackageSymbol& package) {
  auto it = packageBodyIds_.find(&package);
  if (it != packageBodyIds_.end()) return it->second;
  int64_t bodyId = writer_.addBody(0, package.name, "", 0);
  int64_t scopeId = writer_.addScope(0, "package", package.name, 0);
  BodyInfo info;
  info.id = bodyId;
  info.scopeId = scopeId;
  info.parentInstanceId = 0;
  info.ownerInstanceId = 0;
  info.body = nullptr;
  indexPackageScope(package, info, scopeId);
  packageBodyIds_[&package] = bodyId;
  return bodyId;
}

void Indexer::indexPackageScope(const slang::ast::PackageSymbol& package, BodyInfo& body,
                                int64_t scopeId) {
  for (const auto& member : package.members()) {
    if (member.kind == slang::ast::SymbolKind::TypeAlias) {
      addTypeAlias(body, member.as<slang::ast::TypeAliasType>(), scopeId);
    } else if (slang::ast::ValueSymbol::isKind(member.kind)) {
      std::string kind = symbolKindName(member.kind);
      if (member.kind == slang::ast::SymbolKind::Parameter) {
        kind = member.as<slang::ast::ParameterSymbol>().isLocalParam() ? "localparam" : "parameter";
      }
      addValueSymbol(body, member.as<slang::ast::ValueSymbol>(), scopeId, kind);
    }
  }
}

void Indexer::indexScope(const slang::ast::Scope& scope, BodyInfo& body, int64_t scopeId) {
  for (const slang::ast::Symbol& member : scope.members()) {
    if (member.kind == slang::ast::SymbolKind::GenerateBlock &&
        member.as<slang::ast::GenerateBlockSymbol>().isUninstantiated) continue;
    if (member.kind == slang::ast::SymbolKind::Port) {
      addPortSymbol(body, member.as<slang::ast::PortSymbol>(), scopeId);
    } else if (member.kind == slang::ast::SymbolKind::TypeParameter) {
      addTypeParameter(body, member.as<slang::ast::TypeParameterSymbol>(), scopeId);
    } else if (member.kind == slang::ast::SymbolKind::TypeAlias) {
      addTypeAlias(body, member.as<slang::ast::TypeAliasType>(), scopeId);
    } else if (slang::ast::ValueSymbol::isKind(member.kind)) {
      std::string kind = symbolKindName(member.kind);
      if (member.kind == slang::ast::SymbolKind::Parameter) {
        kind = member.as<slang::ast::ParameterSymbol>().isLocalParam() ? "localparam" : "parameter";
      }
      addValueSymbol(body, member.as<slang::ast::ValueSymbol>(), scopeId, kind);
    }

    if (member.kind == slang::ast::SymbolKind::ProceduralBlock) {
      for (const auto* block : member.as<slang::ast::ProceduralBlockSymbol>().getBlocks()) {
        if (!block || body.scopes.count(block)) continue;
        int64_t id = writer_.addScope(scopeId, "block", block->name, 0);
        body.scopes[block] = id;
        indexScope(*block, body, id);
      }
    }

    auto* childScope = member.as_if<slang::ast::Scope>();
    if (!childScope) continue;
    if (member.kind == slang::ast::SymbolKind::Instance ||
        member.kind == slang::ast::SymbolKind::InstanceArray ||
        member.kind == slang::ast::SymbolKind::InstanceBody) {
      continue;
    }
    if (body.scopes.count(childScope)) continue;
    if (member.kind == slang::ast::SymbolKind::GenerateBlockArray) {
      const auto& arr = member.as<slang::ast::GenerateBlockArraySymbol>();
      int64_t id = writer_.addScope(scopeId, "generate_array", arr.name, 0);
      body.scopes[&arr] = id;
      for (const auto* entry : arr.entries) {
        if (!entry || entry->isUninstantiated) continue;
        std::string entryName = entry->getExternalName();
        int64_t child = writer_.addScope(id, "generate", entryName, 0);
        body.scopes[entry] = child;
        indexScope(*entry, body, child);
      }
      continue;
    }
    int64_t id = writer_.addScope(scopeId, symbolKindName(member.kind), member.name, 0);
    body.scopes[childScope] = id;
    indexScope(*childScope, body, id);
  }
}

void Indexer::addInstanceOccurrence(const slang::ast::InstanceSymbol& inst, int64_t instanceId) {
  MappedSpan span = spanOf(inst.location, inst.name.size());
  addOccurrence(nullptr, span, "instance", "instance", "resolved", nullptr, "instance", instanceId,
                0, 0, paths_.sanitizeText(inst.getDefinition().name));
}

void Indexer::addInstance(const slang::ast::InstanceSymbol& inst, int64_t parentId, int64_t ordinal,
                          int64_t depth, bool instanceArray) {
  if (instanceIds_.count(&inst)) return;
  if (!inst.isModule()) return;
  int64_t defId = addDefinition(inst.getDefinition());
  int64_t bodyId = addBody(inst.body, defId, parentId);
  BodyInfo& bodyInfo = bodies_.find(&inst.body)->second;
  std::string path = inst.getHierarchicalPath();
  if (path.empty()) path = std::string(inst.name);
  MappedSpan span = spanOf(inst.location, inst.name.size());
  int64_t id = writer_.addInstance(parentId, ordinal, inst.name, inst.getDefinition().name, defId,
                                   bodyId, bodyInfo.scopeId, path, span.valid ? span.sourceId : 0,
                                   span.valid ? span.start : 0, span.valid ? span.end : 0,
                                   span.valid ? span.line : 0, depth, instanceArray);
  instanceIds_[&inst] = id;
  counts_["instances"] = counts_["instances"].get<int64_t>() + 1;
  bodyInfo.ownerInstanceId = id;
  if (rootInstanceId_ == 0) {
    rootInstanceId_ = id;
    rootPath_ = path;
  }
  addInstanceOccurrence(inst, id);
  int64_t childOrdinal = 0;
  collectHierarchy(inst.body, bodyInfo, id, depth + 1, childOrdinal, 0, 0);
}

std::string Indexer::uniqueGenerateName(int64_t parentId, std::string name) {
  auto& used = generateSiblingNames_[parentId];
  if (used.insert(name).second) return name;
  for (size_t i = 2;; i++) {
    std::string candidate = name + "_" + std::to_string(i);
    if (used.insert(candidate).second) return candidate;
  }
}

int64_t Indexer::addGenerateInstance(BodyInfo& body, const slang::ast::Symbol& sym,
                                     std::string_view moduleName, int64_t parentId,
                                     int64_t ordinal, int64_t depth, bool instanceArray,
                                     std::string_view displayName) {
  std::string path = sym.getHierarchicalPath();
  std::string name(displayName);
  if (name.empty()) {
    if (sym.kind == slang::ast::SymbolKind::GenerateBlock) {
      const auto& block = sym.as<slang::ast::GenerateBlockSymbol>();
      if (const auto* index = block.getArrayIndex()) {
        name = "[" + index->toString(slang::LiteralBase::Decimal, false) + "]";
      } else {
        name = block.getExternalName();
      }
      if (name.empty() && block.isUnnamed) name = "__genblk";
    } else if (sym.kind == slang::ast::SymbolKind::GenerateBlockArray) {
      const auto& arr = sym.as<slang::ast::GenerateBlockArraySymbol>();
      name = arr.getExternalName();
      if (name.empty() && arr.isUnnamed) name = "__genblk";
    }
    if (name.empty()) {
      size_t dot = path.rfind('.');
      name = dot == std::string::npos ? path : path.substr(dot + 1);
    }
  }
  if (name.empty()) name = "__genblk";
  name = uniqueGenerateName(parentId, std::move(name));
  if (path.empty()) path = std::to_string(parentId) + "::" + name;
  MappedSpan span = spanOf(sym.location, std::max<size_t>(1, sym.name.size()));
  if (!span.valid) {
    if (const auto* syntax = sym.getSyntax()) span = spanOf(syntax->sourceRange(), 0);
  }
  int64_t scopeId = 0;
  if (const auto* generateScope = sym.as_if<slang::ast::Scope>()) {
    if (auto scopeIt = body.scopes.find(generateScope); scopeIt != body.scopes.end()) {
      scopeId = scopeIt->second;
    }
  }
  int64_t id = writer_.addInstance(parentId, ordinal, name, moduleName, 0, body.id, scopeId, path,
                                   span.valid ? span.sourceId : 0, span.valid ? span.start : 0,
                                   span.valid ? span.end : 0, span.valid ? span.line : 0,
                                   depth, instanceArray);
  generateInstanceIds_[&sym] = id;
  counts_["generateScopes"] = counts_["generateScopes"].get<int64_t>() + 1;
  return id;
}

void Indexer::collectHierarchy(const slang::ast::Scope& scope, BodyInfo& body, int64_t parentId,
                               int64_t depth, int64_t& ordinal, int64_t loopOwnerId,
                               int loopNesting) {
  for (const slang::ast::Symbol& member : scope.members()) {
    if (member.kind == slang::ast::SymbolKind::Instance) {
      const auto& inst = member.as<slang::ast::InstanceSymbol>();
      if (!inst.isModule()) continue;
      addInstance(inst, parentId, ordinal++, depth, false);
    } else if (member.kind == slang::ast::SymbolKind::InstanceArray) {
      const auto& arr = member.as<slang::ast::InstanceArraySymbol>();
      for (const auto* element : arr.elements) {
        if (!element || element->kind != slang::ast::SymbolKind::Instance) continue;
        const auto& inst = element->as<slang::ast::InstanceSymbol>();
        if (!inst.isModule()) continue;
        addInstance(inst, parentId, ordinal++, depth, true);
      }
    } else if (member.kind == slang::ast::SymbolKind::GenerateBlock) {
      const auto& block = member.as<slang::ast::GenerateBlockSymbol>();
      if (block.isUninstantiated) {
        // Conditional branches are per-iteration when nested in a loop
        // generate; top-level branches belong to the whole body.
        recordInactiveBlock(block, body, loopOwnerId);
        continue;
      }
      int64_t node = addGenerateInstance(body, block, "$generate", parentId, ordinal++, depth, false);
      int64_t childOrdinal = 0;
      collectHierarchy(block, body, node, depth + 1, childOrdinal, loopOwnerId, loopNesting);
    } else if (member.kind == slang::ast::SymbolKind::GenerateBlockArray) {
      // Flatten `gen_name` + `[i]` into a single `gen_name[i]` node under the
      // enclosing scope, so every loop iteration occupies one tree level.
      const auto& arr = member.as<slang::ast::GenerateBlockArraySymbol>();
      std::string base = arr.getExternalName();
      if (base.empty()) base = "__genblk";
      if (arr.valid && arr.entries.empty()) {
        const auto* syntax = arr.getSyntax();
        if (syntax && syntax->kind == slang::syntax::SyntaxKind::LoopGenerate) {
          const auto& loop = syntax->as<slang::syntax::LoopGenerateSyntax>();
          if (loop.block) {
            recordInactiveSpan(spanOf(loop.block->sourceRange(), 0), body, "loop", loopOwnerId);
          }
        }
      }
      size_t activeEntries = 0;
      for (const auto* entry : arr.entries) {
        if (entry && !entry->isUninstantiated) activeEntries++;
      }
      int64_t entryOrdinal = 0;
      for (const auto* entry : arr.entries) {
        if (!entry) continue;
        if (entry->isUninstantiated) {
          recordInactiveBlock(*entry, body, loopOwnerId);
          continue;
        }
        std::string display = base;
        if (const auto* index = entry->getArrayIndex()) {
          display += "[" + index->toString(slang::LiteralBase::Decimal, false) + "]";
        } else {
          display += "[" + std::to_string(entryOrdinal) + "]";
        }
        int64_t entryNode = addGenerateInstance(body, *entry, "$generate_iter", parentId,
                                                ordinal++, depth, false, display);
        int64_t childOrdinal = 0;
        // A loop with a single iteration has a fixed genvar value; keep the
        // enclosing owner so parent-scope views still gray branches selected
        // by that iteration. Multi-iteration conditions stay per-entry.
        int64_t childOwner = activeEntries == 1 ? loopOwnerId : entryNode;
        const int ownerDepth = childOwner == entryNode ? loopNesting + 1 : loopNesting;
        for (const auto& member : entry->members()) {
          if (member.kind == slang::ast::SymbolKind::Parameter &&
              member.as<slang::ast::ParameterSymbol>().isFromGenvar()) {
            genvarOwnerIds_[&member] = childOwner;
            genvarOwnerDepth_[&member] = ownerDepth;
          }
        }
        collectHierarchy(*entry, body, entryNode, depth + 1, childOrdinal, childOwner,
                         loopNesting + 1);
        entryOrdinal++;
      }
    }
  }
}

int64_t Indexer::scopeInstanceForSymbol(const slang::ast::Symbol& sym, int64_t fallback) const {
  for (const slang::ast::Scope* scope = sym.getParentScope(); scope;
       scope = scope->asSymbol().getParentScope()) {
    auto it = generateInstanceIds_.find(&scope->asSymbol());
    if (it != generateInstanceIds_.end()) return it->second;
  }
  return fallback;
}

int64_t Indexer::scopeInstanceForInstance(const slang::ast::InstanceSymbol& inst,
                                           int64_t fallback) const {
  for (const slang::ast::Scope* scope = inst.getParentScope(); scope;
       scope = scope->asSymbol().getParentScope()) {
    auto it = generateInstanceIds_.find(&scope->asSymbol());
    if (it != generateInstanceIds_.end()) return it->second;
  }
  return fallback;
}

void Indexer::addBodyReferences(BodyInfo& body) {
  RefVisitor visitor(*this, body);
  body.body->visit(visitor);
  addGenerateReferences(body, *body.body);
}

void Indexer::addGenerateReferences(BodyInfo& body, const slang::ast::Scope& scope) {
  RefVisitor visitor(*this, body);
  for (const auto& member : scope.members()) {
    if (member.kind == slang::ast::SymbolKind::GenerateBlock) {
      const auto& block = member.as<slang::ast::GenerateBlockSymbol>();
      if (block.isUninstantiated) continue;
      if (const auto* cond = block.getConditionExpression()) cond->visit(visitor);
      addGenerateReferences(body, block);
    } else if (member.kind == slang::ast::SymbolKind::GenerateBlockArray) {
      const auto& arr = member.as<slang::ast::GenerateBlockArraySymbol>();
      if (arr.initialExpression) arr.initialExpression->visit(visitor);
      if (arr.stopExpression) arr.stopExpression->visit(visitor);
      if (arr.iterExpression) arr.iterExpression->visit(visitor);
      for (const auto* entry : arr.entries) {
        if (entry && !entry->isUninstantiated) addGenerateReferences(body, *entry);
      }
    }
  }
}

void Indexer::addDriverEdge(const DriverRecord& d) {
  // Repeated generate blocks share source locations and target symbols, so the
  // dedup key must include the source instance and the driven bit range.
  std::string key = std::to_string(d.bodyId) + ":" + std::to_string(d.instanceId) + ":" +
                    std::to_string(d.targetSymbolId) + ":" + std::to_string(d.targetBitLo) + ":" +
                    std::to_string(d.targetBitHi) + ":" + std::to_string(d.sourceInstanceId) + ":" +
                    std::to_string(d.sourceSymbolId) + ":" + std::to_string(d.sourceId) + ":" +
                    std::to_string(d.startByte) + ":" + std::to_string(d.endByte) + ":" + d.kind;
  if (!driverKeys_.insert(key).second) return;
  writer_.addDriver(d);
  counts_["drivers"] = counts_["drivers"].get<int64_t>() + 1;
}

void Indexer::addLoadEdge(const LoadRecord& l) {
  std::string key = std::to_string(l.sourceBodyId) + ":" + std::to_string(l.sourceInstanceId) +
                    ":" + std::to_string(l.sourceSymbolId) + ":" +
                    std::to_string(l.targetBodyId) + ":" + std::to_string(l.targetInstanceId) +
                    ":" + std::to_string(l.targetSymbolId) + ":" + l.role + ":" +
                    std::to_string(l.useSourceId) + ":" + std::to_string(l.useStartByte) + ":" +
                    std::to_string(l.useEndByte);
  if (!loadKeys_.insert(key).second) return;
  writer_.addLoad(l);
  counts_["loads"] = counts_["loads"].get<int64_t>() + 1;
}

std::string Indexer::symbolPathKey(const slang::ast::Symbol& sym) const {
  // A stable name for a symbol relative to its owning instance body. Slang's
  // analysis deduplicates identical bodies into a canonical one, so this key
  // is used to find the canonical counterpart of a symbol in a duplicate body.
  std::vector<std::string> parts;
  for (const slang::ast::Scope* scope = sym.getParentScope(); scope;
       scope = scope->asSymbol().getParentScope()) {
    const auto& owner = scope->asSymbol();
    if (owner.kind == slang::ast::SymbolKind::InstanceBody) break;
    std::string name(owner.name);
    if (owner.kind == slang::ast::SymbolKind::GenerateBlock) {
      const auto& block = owner.as<slang::ast::GenerateBlockSymbol>();
      name = block.getExternalName();
      if (const auto* index = block.getArrayIndex())
        name += "[" + index->toString(slang::LiteralBase::Decimal, false) + "]";
    } else if (owner.kind == slang::ast::SymbolKind::GenerateBlockArray) {
      name = owner.as<slang::ast::GenerateBlockArraySymbol>().getExternalName();
    }
    parts.push_back(std::to_string(int(owner.kind)) + ":" + name + ":" +
                    std::to_string(reinterpret_cast<uintptr_t>(owner.getSyntax())));
  }
  std::reverse(parts.begin(), parts.end());
  std::string key;
  for (const auto& part : parts) {
    key += part;
    key += '/';
  }
  key += std::to_string(int(sym.kind)) + ":" + std::string(sym.name) + ":" +
         std::to_string(reinterpret_cast<uintptr_t>(sym.getSyntax()));
  return key;
}

const std::unordered_map<std::string, const slang::ast::Symbol*>& Indexer::bodySymbolMap(
    const slang::ast::InstanceBodySymbol& body) {
  auto found = bodySymbolMaps_.find(&body);
  if (found != bodySymbolMaps_.end()) return found->second;
  auto& map = bodySymbolMaps_[&body];
  std::function<void(const slang::ast::Scope&)> walk = [&](const slang::ast::Scope& scope) {
    for (const auto& member : scope.members()) {
      map.emplace(symbolPathKey(member), &member);
      if (member.kind == slang::ast::SymbolKind::Instance ||
          member.kind == slang::ast::SymbolKind::InstanceArray ||
          member.kind == slang::ast::SymbolKind::InstanceBody)
        continue;
      if (member.kind == slang::ast::SymbolKind::GenerateBlockArray) {
        const auto& arr = member.as<slang::ast::GenerateBlockArraySymbol>();
        for (const auto* entry : arr.entries)
          if (entry) walk(*entry);
        continue;
      }
      if (const auto* child = member.as_if<slang::ast::Scope>()) walk(*child);
    }
  };
  walk(body);
  return map;
}

void Indexer::addDrivers(BodyInfo& body) {
  // Elaboration can still share bodies even with --disable-instance-caching;
  // slang's analysis then keeps driver data on the canonical body only.
  // Resolve each local symbol to its canonical counterpart before querying.
  const auto* parentInstance = body.body->parentInstance;
  const auto* canonicalBody = parentInstance ? parentInstance->getCanonicalBody() : nullptr;
  const auto* canonicalMap =
      canonicalBody && canonicalBody != body.body ? &bodySymbolMap(*canonicalBody) : nullptr;
  const auto* ownMap = canonicalMap ? &bodySymbolMap(*body.body) : nullptr;

  for (const auto& [symPtr, id] : body.symbols) {
    if (!symPtr || !slang::ast::ValueSymbol::isKind(symPtr->kind)) continue;
    const auto& value = symPtr->as<slang::ast::ValueSymbol>();
    auto drivers = analysis_.getDrivers(value);
    if (canonicalMap) {
      auto canonicalIt = canonicalMap->find(symbolPathKey(value));
      if (canonicalIt != canonicalMap->end() &&
          slang::ast::ValueSymbol::isKind(canonicalIt->second->kind)) {
        const auto& canonicalValue = canonicalIt->second->as<slang::ast::ValueSymbol>();
        drivers = analysis_.getDrivers(canonicalValue);
      }
    }
    for (const auto* d : drivers) {
      if (!d || !d->path.fullExpr) continue;
      // Input-port drivers are synthesized from the actual parent connection
      // below, because the analysis record points at the child declaration.
      if (d->isInputPort()) continue;
      // Output-port connection drivers point at the parent-side actual token
      // (for example `.mst_ports_req_o(mst_reqs)`). They duplicate the port
      // edge synthesized by addPortEdges(), and as jump targets they would
      // only land on the token that was clicked. Keep the real source: the
      // child output port or the actual continuous/procedural driver.
      if (d->flags.has(slang::analysis::DriverFlags::OutputPort)) continue;
      MappedSpan span = spanOf(d->getSourceRange(), 0);
      if (!span.valid) span = spanOf(d->path.fullExpr->sourceRange, 0);
      if (!span.valid) continue;
      auto bounds = d->getBounds();
      const slang::ast::Symbol* containing = d->containingSymbol;
      if (ownMap) {
        auto mapped = ownMap->find(symbolPathKey(*containing));
        containing = mapped != ownMap->end() ? mapped->second : nullptr;
      }
      DriverRecord r;
      r.bodyId = body.id;
      r.instanceId = scopeInstanceForSymbol(*symPtr, body.ownerInstanceId);
      r.sourceInstanceId = containing
                               ? scopeInstanceForSymbol(*containing, body.ownerInstanceId)
                               : body.ownerInstanceId;
      r.targetSymbolId = id;
      r.targetBitLo = int64_t(bounds.first);
      r.targetBitHi = int64_t(bounds.second);
      r.kind = d->kind == slang::analysis::DriverKind::Continuous ? "continuous" : "procedural";
      r.sourceKind = r.kind == "continuous" ? "continuous assign" : driverSourceName(d->source);
      r.sourceId = span.sourceId;
      r.startByte = span.start;
      r.endByte = span.end;
      r.line = span.line;
      r.exactness = d->path.isFullyStatic() ? "exact" : "inexact";
      r.detail = r.sourceKind;
      addDriverEdge(r);
    }
  }
}

void Indexer::addControlPaths(BodyInfo& body, const slang::ast::Expression& expr, std::string role,
                              std::vector<ControlRef>& controls) {
  if (!body.body) return;
  slang::ast::EvalContext eval(*body.body);
  slang::ast::ValuePath::visitPaths(expr, eval, [&](const slang::ast::ValuePath& path) {
    if (!path.fullExpr) return;
    const auto* root = path.rootSymbol();
    if (!root) {
      unsupportedLoads_++;
      return;
    }
    auto it = symbolIds_.find(root);
    if (it == symbolIds_.end()) {
      unsupportedLoads_++;
      return;
    }
    MappedSpan span = spanOf(path.fullExpr->sourceRange, 0);
    if (!span.valid) return;
    ControlRef c;
    c.symbolId = it->second;
    c.lo = int64_t(path.lspBounds.first);
    c.hi = int64_t(path.lspBounds.second);
    c.span = span;
    c.role = role;
    controls.push_back(std::move(c));
  });
}

void Indexer::processAssignment(BodyInfo& body, const slang::ast::AssignmentExpression& expr,
                                const std::vector<ControlRef>& controls,
                                int64_t scopeInstanceId) {
  slang::ast::EvalContext eval(*body.body);
  std::vector<slang::ast::ValuePath> lhs;
  std::vector<slang::ast::ValuePath> rhs;
  slang::ast::ValuePath::visitPaths(expr.left(), eval, [&](const slang::ast::ValuePath& p) { lhs.push_back(p); });
  slang::ast::ValuePath::visitPaths(expr.right(), eval, [&](const slang::ast::ValuePath& p) { rhs.push_back(p); });

  for (const auto& targetPath : lhs) {
    if (!targetPath.fullExpr) continue;
    const auto* targetRoot = targetPath.rootSymbol();
    if (!targetRoot) { unsupportedLoads_++; continue; }
    auto targetIt = symbolIds_.find(targetRoot);
    if (targetIt == symbolIds_.end()) { unsupportedLoads_++; continue; }
    MappedSpan targetSpan = spanOf(targetPath.fullExpr->sourceRange, 0);
    if (!targetSpan.valid) continue;
    int64_t targetSymbolId = targetIt->second;
    int64_t targetLo = int64_t(targetPath.lspBounds.first);
    int64_t targetHi = int64_t(targetPath.lspBounds.second);

    for (const auto& sourcePath : rhs) {
      if (!sourcePath.fullExpr) continue;
      const auto* sourceRoot = sourcePath.rootSymbol();
      if (!sourceRoot) { unsupportedLoads_++; continue; }
      auto sourceIt = symbolIds_.find(sourceRoot);
      if (sourceIt == symbolIds_.end()) { unsupportedLoads_++; continue; }
      MappedSpan sourceSpan = spanOf(sourcePath.fullExpr->sourceRange, 0);
      if (!sourceSpan.valid) continue;
      LoadRecord l;
      l.sourceBodyId = body.id;
      l.sourceInstanceId = scopeInstanceId;
      l.sourceSymbolId = sourceIt->second;
      l.sourceBitLo = int64_t(sourcePath.lspBounds.first);
      l.sourceBitHi = int64_t(sourcePath.lspBounds.second);
      l.targetBodyId = body.id;
      l.targetInstanceId = scopeInstanceId;
      l.targetSymbolId = targetSymbolId;
      l.targetBitLo = targetLo;
      l.targetBitHi = targetHi;
      l.role = "data";
      l.exactness = (sourcePath.isFullyStatic() && targetPath.isFullyStatic()) ? "exact" : "inexact";
      l.useSourceId = sourceSpan.sourceId;
      l.useStartByte = sourceSpan.start;
      l.useEndByte = sourceSpan.end;
      l.targetSourceId = targetSpan.sourceId;
      l.targetStartByte = targetSpan.start;
      l.targetEndByte = targetSpan.end;
      l.detail = expr.isNonBlocking() ? "nonblocking assignment" : "assignment";
      addLoadEdge(l);
    }
    if (expr.isCompound()) {
      LoadRecord l;
      l.sourceBodyId = body.id;
      l.sourceInstanceId = scopeInstanceId;
      l.sourceSymbolId = targetSymbolId;
      l.sourceBitLo = targetLo;
      l.sourceBitHi = targetHi;
      l.targetBodyId = body.id;
      l.targetInstanceId = scopeInstanceId;
      l.targetSymbolId = targetSymbolId;
      l.targetBitLo = targetLo;
      l.targetBitHi = targetHi;
      l.role = "data";
      l.exactness = targetPath.isFullyStatic() ? "exact" : "inexact";
      l.useSourceId = targetSpan.sourceId;
      l.useStartByte = targetSpan.start;
      l.useEndByte = targetSpan.end;
      l.targetSourceId = targetSpan.sourceId;
      l.targetStartByte = targetSpan.start;
      l.targetEndByte = targetSpan.end;
      l.detail = "compound assignment";
      addLoadEdge(l);
    }
    for (const auto& c : controls) {
      LoadRecord l;
      l.sourceBodyId = body.id;
      l.sourceInstanceId = scopeInstanceId;
      l.sourceSymbolId = c.symbolId;
      l.sourceBitLo = c.lo;
      l.sourceBitHi = c.hi;
      l.targetBodyId = body.id;
      l.targetInstanceId = scopeInstanceId;
      l.targetSymbolId = targetSymbolId;
      l.targetBitLo = targetLo;
      l.targetBitHi = targetHi;
      l.role = c.role;
      l.exactness = c.span.valid ? "exact" : "inexact";
      l.useSourceId = c.span.sourceId;
      l.useStartByte = c.span.start;
      l.useEndByte = c.span.end;
      l.targetSourceId = targetSpan.sourceId;
      l.targetStartByte = targetSpan.start;
      l.targetEndByte = targetSpan.end;
      l.detail = c.role;
      addLoadEdge(l);
    }
  }
}

void Indexer::processTiming(BodyInfo& body, const slang::ast::TimingControl& timing,
                            std::vector<ControlRef>& controls) {
  using K = slang::ast::TimingControlKind;
  if (timing.kind == K::SignalEvent) {
    const auto& e = timing.as<slang::ast::SignalEventControl>();
    addControlPaths(body, e.expr, "event", controls);
    if (e.iffCondition) addControlPaths(body, *e.iffCondition, "control", controls);
  } else if (timing.kind == K::EventList) {
    const auto& e = timing.as<slang::ast::EventListControl>();
    for (const auto* child : e.events) {
      if (child) processTiming(body, *child, controls);
    }
  } else {
    unsupportedLoads_++;
  }
}

void Indexer::processStatement(BodyInfo& body, const slang::ast::Statement& stmt,
                               const std::vector<ControlRef>& controls, int64_t scopeInstanceId) {
  using K = slang::ast::StatementKind;
  switch (stmt.kind) {
    case K::List: {
      const auto& list = stmt.as<slang::ast::StatementList>();
      for (const auto* child : list.list) if (child) processStatement(body, *child, controls, scopeInstanceId);
      return;
    }
    case K::Block: {
      const auto& block = stmt.as<slang::ast::BlockStatement>();
      processStatement(body, block.body, controls, scopeInstanceId);
      return;
    }
    case K::Timed: {
      const auto& timed = stmt.as<slang::ast::TimedStatement>();
      auto copy = controls;
      processTiming(body, timed.timing, copy);
      processStatement(body, timed.stmt, copy, scopeInstanceId);
      return;
    }
    case K::Conditional: {
      const auto& cond = stmt.as<slang::ast::ConditionalStatement>();
      auto copy = controls;
      for (const auto& c : cond.conditions) addControlPaths(body, *c.expr, "control", copy);
      processStatement(body, cond.ifTrue, copy, scopeInstanceId);
      if (cond.ifFalse) processStatement(body, *cond.ifFalse, copy, scopeInstanceId);
      return;
    }
    case K::Case: {
      const auto& c = stmt.as<slang::ast::CaseStatement>();
      auto base = controls;
      addControlPaths(body, c.expr, "control", base);
      for (const auto& item : c.items) {
        auto copy = base;
        for (const auto* e : item.expressions) if (e) addControlPaths(body, *e, "control", copy);
        if (item.stmt) processStatement(body, *item.stmt, copy, scopeInstanceId);
      }
      if (c.defaultCase) processStatement(body, *c.defaultCase, base, scopeInstanceId);
      return;
    }
    case K::ForLoop: {
      const auto& loop = stmt.as<slang::ast::ForLoopStatement>();
      auto copy = controls;
      AssignmentVisitor finder(*this, body, copy, scopeInstanceId);
      for (const auto* e : loop.initializers) if (e) e->visit(finder);
      for (const auto* e : loop.steps) if (e) e->visit(finder);
      if (loop.stopExpr) addControlPaths(body, *loop.stopExpr, "control", copy);
      processStatement(body, loop.body, copy, scopeInstanceId);
      return;
    }
    case K::RepeatLoop: {
      const auto& loop = stmt.as<slang::ast::RepeatLoopStatement>();
      auto copy = controls;
      addControlPaths(body, loop.count, "control", copy);
      processStatement(body, loop.body, copy, scopeInstanceId);
      return;
    }
    case K::ForeachLoop: {
      const auto& loop = stmt.as<slang::ast::ForeachLoopStatement>();
      auto copy = controls;
      addControlPaths(body, loop.arrayRef, "control", copy);
      processStatement(body, loop.body, copy, scopeInstanceId);
      return;
    }
    case K::WhileLoop: {
      const auto& loop = stmt.as<slang::ast::WhileLoopStatement>();
      auto copy = controls;
      addControlPaths(body, loop.cond, "control", copy);
      processStatement(body, loop.body, copy, scopeInstanceId);
      return;
    }
    case K::DoWhileLoop: {
      const auto& loop = stmt.as<slang::ast::DoWhileLoopStatement>();
      auto copy = controls;
      addControlPaths(body, loop.cond, "control", copy);
      processStatement(body, loop.body, copy, scopeInstanceId);
      return;
    }
    case K::ForeverLoop: {
      processStatement(body, stmt.as<slang::ast::ForeverLoopStatement>().body, controls, scopeInstanceId);
      return;
    }
    case K::ExpressionStatement: {
      AssignmentVisitor finder(*this, body, controls, scopeInstanceId);
      stmt.as<slang::ast::ExpressionStatement>().expr.visit(finder);
      return;
    }
    case K::VariableDeclaration: {
      const auto& decl = stmt.as<slang::ast::VariableDeclStatement>();
      if (const auto* init = decl.symbol.getInitializer()) {
        AssignmentVisitor finder(*this, body, controls, scopeInstanceId);
        init->visit(finder);
      }
      return;
    }
    default: {
      AssignmentVisitor finder(*this, body, controls, scopeInstanceId);
      stmt.visit(finder);
      return;
    }
  }
}

void Indexer::processScopeAssignments(BodyInfo& body, const slang::ast::Scope& scope,
                                     int64_t scopeInstanceId) {
  for (const slang::ast::Symbol& member : scope.members()) {
    if (member.kind == slang::ast::SymbolKind::ContinuousAssign) {
      const auto& assign = member.as<slang::ast::ContinuousAssignSymbol>().getAssignment();
      if (assign.kind == slang::ast::ExpressionKind::Assignment) {
        processAssignment(body, assign.as<slang::ast::AssignmentExpression>(), {}, scopeInstanceId);
      } else {
        AssignmentVisitor finder(*this, body, {}, scopeInstanceId);
        assign.visit(finder);
      }
    } else if (member.kind == slang::ast::SymbolKind::ProceduralBlock) {
      processStatement(body, member.as<slang::ast::ProceduralBlockSymbol>().getBody(), {},
                       scopeInstanceId);
    } else if (member.kind == slang::ast::SymbolKind::GenerateBlock) {
      const auto& block = member.as<slang::ast::GenerateBlockSymbol>();
      if (block.isUninstantiated) continue;
      auto it = generateInstanceIds_.find(&block);
      processScopeAssignments(body, block, it == generateInstanceIds_.end() ? scopeInstanceId : it->second);
    } else if (member.kind == slang::ast::SymbolKind::GenerateBlockArray) {
      const auto& arr = member.as<slang::ast::GenerateBlockArraySymbol>();
      for (const auto* entry : arr.entries) {
        if (!entry || entry->isUninstantiated) continue;
        auto it = generateInstanceIds_.find(entry);
        processScopeAssignments(body, *entry, it == generateInstanceIds_.end() ? scopeInstanceId : it->second);
      }
    }
  }
}

void Indexer::addLoads(BodyInfo& body) {
  processScopeAssignments(body, *body.body, body.ownerInstanceId);
}

void Indexer::addPortEdges(const slang::ast::InstanceSymbol& inst, BodyInfo& childBody) {
  const slang::ast::Scope* parentScope = inst.getParentScope();
  while (parentScope && parentScope->asSymbol().kind != slang::ast::SymbolKind::InstanceBody)
    parentScope = parentScope->asSymbol().getParentScope();
  if (!parentScope) return;
  const auto& parentBodySym = parentScope->asSymbol().as<slang::ast::InstanceBodySymbol>();
  const auto* parentInst = parentBodySym.parentInstance;
  if (!parentInst) return;
  auto parentInstIt = instanceIds_.find(parentInst);
  auto parentBodyIt = bodies_.find(&parentBodySym);
  auto childInstIt = instanceIds_.find(&inst);
  if (parentInstIt == instanceIds_.end() || parentBodyIt == bodies_.end() ||
      childInstIt == instanceIds_.end()) return;
  int64_t parentInstanceId = parentInstIt->second;
  int64_t childInstanceId = childInstIt->second;
  int64_t actualInstanceId = scopeInstanceForInstance(inst, parentInstanceId);
  BodyInfo& parentBody = parentBodyIt->second;

  for (const auto* conn : inst.getPortConnections()) {
    if (!conn || conn->port.kind != slang::ast::SymbolKind::Port) continue;
    const auto& port = conn->port.as<slang::ast::PortSymbol>();
    auto portIt = symbolIds_.find(&port);
    if (portIt == symbolIds_.end()) continue;
    const auto* expr = conn->getExpression();
    if (!expr) continue;
    std::string actualRole =
        port.direction == slang::ast::ArgumentDirection::Out ? "write" :
        port.direction == slang::ast::ArgumentDirection::InOut ? "readwrite" : "read";
    RefVisitor actualVisitor(*this, parentBody, actualRole);
    expr->visit(actualVisitor);
    int64_t portId = portIt->second;
    int64_t width = int64_t(port.getType().getBitWidth());
    MappedSpan portSpan = spanOf(port.location, port.name.size());
    slang::ast::EvalContext eval(*parentBody.body);
    slang::ast::ValuePath::visitPaths(*expr, eval, [&](const slang::ast::ValuePath& path) {
      if (!path.fullExpr) return;
      const auto* root = path.rootSymbol();
      if (!root) { unsupportedLoads_++; return; }
      auto rootIt = symbolIds_.find(root);
      if (rootIt == symbolIds_.end()) { unsupportedLoads_++; return; }
      MappedSpan useSpan = spanOf(path.fullExpr->sourceRange, 0);
      if (!useSpan.valid) return;
      int64_t sourceSymbolId = rootIt->second;
      int64_t lo = int64_t(path.lspBounds.first);
      int64_t hi = int64_t(path.lspBounds.second);
      std::string exactness = path.isFullyStatic() ? "exact" : "inexact";
      bool input = port.direction == slang::ast::ArgumentDirection::In ||
                   port.direction == slang::ast::ArgumentDirection::InOut ||
                   port.direction == slang::ast::ArgumentDirection::Ref;
      bool output = port.direction == slang::ast::ArgumentDirection::Out ||
                    port.direction == slang::ast::ArgumentDirection::InOut;
      if (input) {
        DriverRecord d;
        d.bodyId = childBody.id;
        d.instanceId = childInstanceId;
        d.targetSymbolId = portId;
        d.targetBitLo = 0;
        d.targetBitHi = width > 0 ? width - 1 : 0;
        d.kind = "port";
        d.sourceKind = "parent input";
        d.sourceSymbolId = sourceSymbolId;
        d.sourceInstanceId = actualInstanceId;
        d.sourceBitLo = lo;
        d.sourceBitHi = hi;
        d.sourceId = useSpan.sourceId;
        d.startByte = useSpan.start;
        d.endByte = useSpan.end;
        d.line = useSpan.line;
        d.exactness = exactness;
        d.detail = "parent connection";
        // A port and its internal net are two symbol rows for the same signal.
        // Keep one driver row, targeting the referenceable internal symbol when
        // possible, and let the query layer union the alias for port clicks.
        if (port.internalSymbol) {
          auto internalIt = symbolIds_.find(port.internalSymbol);
          if (internalIt != symbolIds_.end()) d.targetSymbolId = internalIt->second;
        }
        addDriverEdge(d);

        LoadRecord l;
        l.sourceBodyId = parentBody.id;
        l.targetBodyId = childBody.id;
        l.sourceInstanceId = actualInstanceId;
        l.sourceSymbolId = sourceSymbolId;
        l.sourceBitLo = lo;
        l.sourceBitHi = hi;
        l.targetInstanceId = childInstanceId;
        l.targetSymbolId = portId;
        l.targetBitLo = 0;
        l.targetBitHi = width > 0 ? width - 1 : 0;
        l.role = "port";
        l.exactness = exactness;
        l.useSourceId = useSpan.sourceId;
        l.useStartByte = useSpan.start;
        l.useEndByte = useSpan.end;
        l.targetSourceId = portSpan.valid ? portSpan.sourceId : 0;
        l.targetStartByte = portSpan.valid ? portSpan.start : 0;
        l.targetEndByte = portSpan.valid ? portSpan.end : 0;
        l.detail = "parent input";
        addLoadEdge(l);
      }
      if (output) {
        DriverRecord d;
        d.bodyId = parentBody.id;
        d.instanceId = actualInstanceId;
        d.targetSymbolId = sourceSymbolId;
        d.targetBitLo = lo;
        d.targetBitHi = hi;
        d.kind = "port";
        d.sourceKind = "child output";
        d.sourceSymbolId = portId;
        d.sourceInstanceId = childInstanceId;
        d.sourceBitLo = 0;
        d.sourceBitHi = width > 0 ? width - 1 : 0;
        d.sourceId = portSpan.valid ? portSpan.sourceId : useSpan.sourceId;
        d.startByte = portSpan.valid ? portSpan.start : useSpan.start;
        d.endByte = portSpan.valid ? portSpan.end : useSpan.end;
        d.line = portSpan.valid ? portSpan.line : useSpan.line;
        d.exactness = exactness;
        d.detail = "parent connection";
        addDriverEdge(d);

        LoadRecord l;
        l.sourceBodyId = childBody.id;
        l.sourceInstanceId = childInstanceId;
        l.sourceSymbolId = portId;
        l.sourceBitLo = 0;
        l.sourceBitHi = width > 0 ? width - 1 : 0;
        l.targetBodyId = parentBody.id;
        l.targetInstanceId = actualInstanceId;
        l.targetSymbolId = sourceSymbolId;
        l.targetBitLo = lo;
        l.targetBitHi = hi;
        l.role = "port";
        l.exactness = exactness;
        l.useSourceId = portSpan.valid ? portSpan.sourceId : useSpan.sourceId;
        l.useStartByte = portSpan.valid ? portSpan.start : useSpan.start;
        l.useEndByte = portSpan.valid ? portSpan.end : useSpan.end;
        l.targetSourceId = useSpan.sourceId;
        l.targetStartByte = useSpan.start;
        l.targetEndByte = useSpan.end;
        l.detail = "child output";
        addLoadEdge(l);
      }
    });
  }
  addParameterOverrideRefs(inst, parentBody);
}

void Indexer::addParameterOverrideRefs(const slang::ast::InstanceSymbol& inst,
                                       BodyInfo& parentBody) {
  for (const auto* p : inst.body.getParameters()) {
    if (!p) continue;
    RefVisitor visitor(*this, parentBody, "read");
    if (p->symbol.kind == slang::ast::SymbolKind::Parameter) {
      const auto& param = p->symbol.as<slang::ast::ParameterSymbol>();
      if (!param.isOverridden()) continue;
      const auto dt = param.getDeclaredType();
      const auto* init = dt ? dt->getInitializer() : nullptr;
      if (init) init->visit(visitor);
    } else if (p->symbol.kind == slang::ast::SymbolKind::TypeParameter) {
      const auto& param = p->symbol.as<slang::ast::TypeParameterSymbol>();
      if (!param.isOverridden()) continue;
      // A type binding has no initializer expression; the override's type
      // syntax points into the parent file and still carries the package
      // prefix, so emit occurrences from it directly in the parent body.
      const auto* typeSyntax = param.targetType.getTypeSyntax();
      if (!typeSyntax) typeSyntax = param.targetType.getResolvedTypeSyntax();
      if (!typeSyntax || !parentBody.body) continue;
      addTypeSyntaxOccurrences(parentBody, *typeSyntax, param.targetType.getType(),
                               *parentBody.body);
      addTypeDimensionRefs(parentBody, *typeSyntax, *parentBody.body);
    }
  }
}

void Indexer::addPreprocessorLinks() {
  for (const auto& treePtr : compilation_.getSyntaxTrees()) {
    if (!treePtr) continue;
    const auto& tree = *treePtr;
    for (const auto& inc : tree.getIncludeDirectives()) {
      if (!inc.syntax) continue;
      MappedSpan span = spanOf(inc.syntax->fileName.range(), inc.path.size());
      SourceInfo* target = sources_.byBuffer(inc.buffer.id);
      MappedSpan targetSpan;
      if (target) {
        targetSpan.valid = true;
        targetSpan.sourceId = target->id;
        targetSpan.start = 0;
        size_t nl = target->data.find('\n');
        targetSpan.end = int64_t(nl == std::string::npos ? target->data.size() : nl);
        targetSpan.line = 1;
      }
      addOccurrence(nullptr, span, "include", "include", target ? "resolved" : "unresolved",
                    target ? &targetSpan : nullptr, "source", 0, 0, 0,
                    target ? target->displayPath : paths_.sanitizeText(inc.path));
      writer_.addInclude(span.valid ? span.sourceId : 0, span.valid ? span.start : 0,
                         span.valid ? span.end : 0, target ? target->id : 0, inc.isSystem);
    }
    for (const auto& ref : tree.getMacroRefs()) {
      if (!ref.syntax || !ref.definition) continue;
      MappedSpan defSpan = spanOf(ref.definition->sourceRange(), 0);
      int64_t macroId = 0;
      auto found = macroDefIds_.find(ref.definition);
      if (found != macroDefIds_.end()) {
        macroId = found->second;
      } else if (defSpan.valid) {
        std::string raw = textOf(defSpan);
        std::string name = macroDefinitionName(raw);
        std::string body = raw;
        size_t nl = body.find('\n');
        if (nl != std::string::npos) body = body.substr(nl + 1);
        macroId = writer_.addMacroDefinition(name, defSpan.sourceId, defSpan.start, defSpan.end,
                                             defSpan.line, body.substr(0, 8192));
        macroDefIds_[ref.definition] = macroId;
      }
      if (!macroId) continue;
      MappedSpan span = spanOf(ref.syntax->sourceRange(), 0);
      std::string detail = cleanName(textOf(span));
      addOccurrence(nullptr, span, "macro", "macro", "resolved", &defSpan, "macro", 0, macroId, 0,
                    detail);
      writer_.addMacroUse(0, span.valid ? span.sourceId : 0, span.valid ? span.start : 0,
                          span.valid ? span.end : 0, macroId);
    }
  }
}

void Indexer::addPreprocessorRegions() {
  using slang::syntax::SyntaxKind;
  struct DirectivePos {
    int64_t sourceId = 0;
    int64_t start = 0;
    int64_t line = 0;
  };
  struct DisabledBranch {
    int64_t sourceId = 0;
    int64_t startLine = 0;
    int64_t endLine = 0;
    int64_t lastByte = 0;
    std::string kind;
  };
  std::vector<DirectivePos> directives;
  std::vector<DisabledBranch> branches;
  std::unordered_set<std::string> seen;

  auto conditionalKind = [](SyntaxKind kind) {
    switch (kind) {
      case SyntaxKind::IfDefDirective:
      case SyntaxKind::IfNDefDirective:
      case SyntaxKind::ElsIfDirective:
      case SyntaxKind::ElseDirective:
      case SyntaxKind::EndIfDirective:
        return true;
      default:
        return false;
    }
  };
  auto directiveName = [](SyntaxKind kind) -> const char* {
    switch (kind) {
      case SyntaxKind::IfDefDirective: return "ifdef";
      case SyntaxKind::IfNDefDirective: return "ifndef";
      case SyntaxKind::ElsIfDirective: return "elsif";
      case SyntaxKind::ElseDirective: return "else";
      case SyntaxKind::EndIfDirective: return "endif";
      default: return "preprocessor";
    }
  };

  for (const auto& treePtr : compilation_.getSyntaxTrees()) {
    if (!treePtr) continue;
    const auto& root = treePtr->root();
    for (auto it = root.tokens_begin(); it != root.tokens_end(); ++it) {
      const auto& token = *it;
      for (const auto& trivia : token.trivia()) {
        if (trivia.kind != slang::parsing::TriviaKind::Directive) continue;
        const auto* node = trivia.syntax();
        if (!node || !conditionalKind(node->kind)) continue;
        const auto& first = node->getFirstToken();
        // Conditional directives inside macro bodies are expanded at the macro
        // call site. Their original locations point into the macro definition,
        // so treating them as source-level branches would gray active call
        // sites and unrelated lines in the include file.
        if (!first.location().valid() || sm_.isMacroLoc(first.location()) ||
            sm_.isMacroArgLoc(first.location())) {
          continue;
        }
        MappedSpan directiveSpan = spanOf(first.location(), first.rawText().size());
        if (directiveSpan.valid) {
          directives.push_back({directiveSpan.sourceId, directiveSpan.start, directiveSpan.line});
        }

        const slang::syntax::TokenList* disabled = nullptr;
        switch (node->kind) {
          case SyntaxKind::IfDefDirective:
          case SyntaxKind::IfNDefDirective:
          case SyntaxKind::ElsIfDirective:
            disabled = &node->as<slang::syntax::ConditionalBranchDirectiveSyntax>().disabledTokens;
            break;
          case SyntaxKind::ElseDirective:
          case SyntaxKind::EndIfDirective:
            disabled = &node->as<slang::syntax::UnconditionalBranchDirectiveSyntax>().disabledTokens;
            break;
          default:
            break;
        }
        if (!disabled || disabled->empty()) continue;

        struct TokenLines {
          int64_t sourceId = 0;
          int64_t startLine = 0;
          int64_t endLine = 0;
          int64_t lastByte = 0;
        };
        std::map<int64_t, TokenLines> bySource;
        for (const auto& skipped : *disabled) {
          if (skipped.isMissing() || !skipped.location().valid() || skipped.rawText().empty()) continue;
          MappedSpan span = spanOf(skipped.location(), skipped.rawText().size());
          if (!span.valid) continue;
          auto& lines = bySource[span.sourceId];
          lines.sourceId = span.sourceId;
          if (lines.startLine == 0 || span.line < lines.startLine) lines.startLine = span.line;
          if (span.line > lines.endLine) lines.endLine = span.line;
          if (span.end > lines.lastByte) lines.lastByte = span.end;
        }
        for (const auto& [sourceId, lines] : bySource) {
          if (lines.startLine <= 0 || lines.endLine <= 0) continue;
          int64_t startLine = lines.startLine;
          if (directiveSpan.valid && directiveSpan.sourceId == sourceId &&
              directiveSpan.line + 1 < startLine) {
            // Include comments and blank lines between the directive and the
            // first disabled token.
            startLine = directiveSpan.line + 1;
          }
          branches.push_back({sourceId, startLine, lines.endLine, lines.lastByte,
                              directiveName(node->kind)});
        }
      }
    }
  }

  std::map<int64_t, std::vector<DirectivePos>> directivesBySource;
  for (const auto& pos : directives) directivesBySource[pos.sourceId].push_back(pos);
  for (auto& [sourceId, list] : directivesBySource) {
    (void)sourceId;
    std::sort(list.begin(), list.end(),
              [](const DirectivePos& a, const DirectivePos& b) { return a.start < b.start; });
  }

  for (auto& branch : branches) {
    auto listIt = directivesBySource.find(branch.sourceId);
    if (listIt != directivesBySource.end()) {
      for (const auto& pos : listIt->second) {
        if (pos.start <= branch.lastByte) continue;
        if (pos.line > branch.endLine) {
          // The next sibling directive starts after trailing comments or
          // blank lines; those lines are still inside the skipped branch.
          branch.endLine = pos.line - 1;
        }
        break;
      }
    }
    SourceInfo* info = sources_.byId(branch.sourceId);
    if (!info || info->lineStarts.empty()) continue;
    const int64_t totalLines = int64_t(info->lineStarts.size());
    if (branch.startLine < 1) branch.startLine = 1;
    if (branch.endLine > totalLines) branch.endLine = totalLines;
    if (branch.endLine < branch.startLine) continue;
    int64_t startByte = info->lineStarts[size_t(branch.startLine - 1)];
    int64_t endByte = branch.endLine < totalLines
                          ? info->lineStarts[size_t(branch.endLine)]
                          : int64_t(info->data.size());
    if (endByte <= startByte) continue;
    std::string key = std::to_string(branch.sourceId) + ":" + std::to_string(startByte) + ":" +
                      std::to_string(endByte);
    if (!seen.insert(key).second) continue;
    writer_.addPreprocessorRegion(branch.sourceId, startByte, endByte, branch.startLine,
                                  branch.endLine, branch.kind, "");
  }
}

void Indexer::addGlobalPackageImports() {
  BodyInfo global;
  for (const auto* pkg : compilation_.getPackages()) {
    if (!pkg) continue;
    for (const auto& member : pkg->members()) {
      if (member.kind == slang::ast::SymbolKind::ExplicitImport ||
          member.kind == slang::ast::SymbolKind::WildcardImport)
        addImportSymbol(global, member);
    }
  }
}

void Indexer::run() {
  auto tops = compilation_.getRoot().topInstances;
  if (tops.empty()) throw std::runtime_error("no top-level instance was elaborated");
  if (tops.size() != 1) throw std::runtime_error("multiple top-level instances; an explicit single Top is required");
  // Record every module/interface/program declaration in the compilation, not
  // only instantiated ones, so a file containing several definitions has a
  // complete set of source extents for scope shading.
  for (const auto* symbol : compilation_.getDefinitions()) {
    if (symbol->kind == slang::ast::SymbolKind::Definition) {
      addDefinition(symbol->as<slang::ast::DefinitionSymbol>());
    }
  }
  for (const auto* package : compilation_.getPackages()) {
    if (!package) continue;
    const auto* syntax = package->getSyntax();
    if (!syntax) continue;
    MappedSpan full = spanOf(syntax->sourceRange(), 0);
    if (!full.valid || full.end <= full.start) continue;
    writer_.addSourceScope(0, "package", package->name, full.sourceId, full.start, full.end,
                           lineStartOf(full), lineEndOf(full));
    addPackageBody(*package);
  }
  int64_t ordinal = 0;
  addInstance(*tops.front(), 0, ordinal, 0, false);
  if (rootInstanceId_ == 0) throw std::runtime_error("root instance was not indexed");

  addPreprocessorLinks();
  addPreprocessorRegions();
  addGlobalPackageImports();
  for (auto& [ptr, body] : bodies_) {
    (void)ptr;
    addBodyReferences(body);
    addDrivers(body);
    addLoads(body);
  }
  for (const auto* inst : [&]() {
         std::vector<const slang::ast::InstanceSymbol*> v;
         v.reserve(instanceIds_.size());
         for (const auto& [p, id] : instanceIds_) { (void)id; v.push_back(p); }
         return v;
       }()) {
    auto bit = bodies_.find(&inst->body);
    if (bit != bodies_.end()) addPortEdges(*inst, bit->second);
  }
  for (const auto& [portId, internal] : pendingPortAliases_) {
    auto it = symbolIds_.find(internal);
    if (it != symbolIds_.end() && it->second != portId) writer_.addSymbolAlias(portId, it->second);
  }
  counts_["sources"] = int64_t(sources_.all().size());
  counts_["unsupportedLoads"] = int64_t(unsupportedLoads_);
}

nlohmann::json Indexer::counts() const { return counts_; }

nlohmann::json Indexer::capabilities() const {
  return nlohmann::json::array({"hierarchy", "resolved-symbols", "types-values",
                                "drivers-bit-mapping", "loads-direct-dependencies",
                                "preprocessor-provenance", "definition-links",
                                "source-snapshot"});
}

nlohmann::json Indexer::capabilityComplete() const {
  nlohmann::json out = nlohmann::json::object();
  for (const auto& cap : capabilities()) {
    std::string name = cap.get<std::string>();
    bool complete = name != "loads-direct-dependencies";
    std::string reason = complete ? "" : "function-body reads, interface/modport/inout mapping and dynamic bit mapping are not complete in this vertical slice";
    out[name] = {{"present", true}, {"complete", complete}, {"reason", reason.empty() ? nlohmann::json(nullptr) : nlohmann::json(reason)}};
  }
  return out;
}

} // namespace rtl
