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

#include "diagnostics.h"

#include <slang/diagnostics/DiagnosticEngine.h>
#include <slang/diagnostics/Diagnostics.h>
#include <slang/text/SourceManager.h>

#include "input/path_policy.h"

namespace rtl {
namespace {

std::string severityName(slang::DiagnosticSeverity severity) {
  switch (severity) {
    case slang::DiagnosticSeverity::Error:
    case slang::DiagnosticSeverity::Fatal:
      return "error";
    case slang::DiagnosticSeverity::Warning:
      return "warning";
    case slang::DiagnosticSeverity::Note:
      return "note";
    case slang::DiagnosticSeverity::Ignored:
      return "info";
  }
  return "info";
}

} // namespace

StreamingDiagnosticClient::StreamingDiagnosticClient(Protocol& protocol, const PathPolicy& paths,
                                                     std::string stage)
    : protocol_(protocol), paths_(paths), stage_(std::move(stage)) {
  showAbsPaths(false);
  setColumnUnit(slang::ColumnUnit::Byte);
}

void StreamingDiagnosticClient::setStage(std::string stage) {
  std::lock_guard<std::mutex> lock(mutex_);
  stage_ = std::move(stage);
}

void StreamingDiagnosticClient::report(const slang::ReportedDiagnostic& d) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (emitted_ >= kMaxDiagnostics) {
    omitted_++;
    return;
  }
  nlohmann::json diag = {
      {"sequence", emitted_},
      {"stage", stage_},
      {"severity", severityName(d.severity)},
      {"code", std::string(slang::toString(d.originalDiagnostic.code))},
      {"message", paths_.sanitizeText(d.formattedMessage)},
  };
  if (d.location.valid() && sourceManager) {
    std::string file = std::string(getFileName(d.location));
    if (!file.empty()) {
      int line = int(sourceManager->getLineNumber(d.location));
      int column = int(getColumnNumber(d.location));
      diag["primaryLocation"] = locationJson(paths_.displayPath(file), line, column);
    }
  }
  if (!d.notes.empty()) {
    nlohmann::json notes = nlohmann::json::array();
    for (const auto& note : d.notes) {
      nlohmann::json n = {{"severity", "note"}, {"message", paths_.sanitizeText(note.formattedMessage)}};
      if (note.location.valid() && sourceManager) {
        std::string file = std::string(getFileName(note.location));
        if (!file.empty()) {
          n["primaryLocation"] = locationJson(
              paths_.displayPath(file), int(sourceManager->getLineNumber(note.location)),
              int(getColumnNumber(note.location)));
        }
      }
      notes.push_back(std::move(n));
    }
    diag["relatedNotes"] = std::move(notes);
  }
  protocol_.diagnostic(diag);
  emitted_++;
}

} // namespace rtl
