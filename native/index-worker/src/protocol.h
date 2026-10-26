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
#include <cstdio>
#include <mutex>
#include <string>
#include <string_view>

#include <nlohmann/json.hpp>

namespace rtl {

class Protocol {
public:
  Protocol(std::string jobId);
  ~Protocol();

  void send(nlohmann::json payload);
  void hello(const nlohmann::json& capabilities, std::string_view compilerVersion,
             std::string_view extractorVersion);
  void stage(std::string_view stage, std::string_view state, long long elapsedMs = -1);
  void progress(std::string_view stage, const nlohmann::json& counts, long long elapsedMs);
  void diagnostic(const nlohmann::json& diagnostic);
  void artifactReady(const nlohmann::json& artifact);
  void failed(std::string_view code, std::string_view message, bool retryable);
  void cancelled();

private:
  std::mutex mutex_;
  std::string jobId_;
  int fd_ = -1;
  FILE* out_ = nullptr;
  uint64_t seq_ = 0;
};

nlohmann::json locationJson(std::string_view displayPath, int line, int column,
                            int endLine = 0, int endColumn = 0);

} // namespace rtl
