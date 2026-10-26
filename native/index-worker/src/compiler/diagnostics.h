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
#include <cstddef>
#include <mutex>
#include <string>

#include <slang/diagnostics/DiagnosticClient.h>

#include "input/path_policy.h"
#include "protocol.h"

namespace rtl {

class StreamingDiagnosticClient final : public slang::DiagnosticClient {
public:
  StreamingDiagnosticClient(Protocol& protocol, const PathPolicy& paths, std::string stage);
  void report(const slang::ReportedDiagnostic& diagnostic) override;
  void setStage(std::string stage);
  size_t emitted() const { return emitted_; }
  size_t omitted() const { return omitted_; }

private:
  Protocol& protocol_;
  const PathPolicy& paths_;
  mutable std::mutex mutex_;
  std::string stage_;
  size_t emitted_ = 0;
  size_t omitted_ = 0;
  static constexpr size_t kMaxDiagnostics = 10000;
};

} // namespace rtl
