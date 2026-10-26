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

#include "protocol.h"

#include <stdexcept>

#include "platform.h"

namespace rtl {

namespace {
constexpr int kStdoutFd = 1;
constexpr int kStderrFd = 2;
}

Protocol::Protocol(std::string jobId) : jobId_(std::move(jobId)) {
  fd_ = platform::duplicateFd(kStdoutFd);
  if (fd_ < 0) throw std::runtime_error("cannot duplicate worker stdout");
  // From here on library output written to stdout goes to stderr. The protocol
  // owns the original stdout descriptor only.
  if (platform::redirectFd(kStderrFd, kStdoutFd) < 0) {
    throw std::runtime_error("cannot redirect stdout");
  }
  platform::setBinaryFd(fd_);
  out_ = platform::fdopenFd(fd_, "w");
  if (!out_) throw std::runtime_error("cannot open protocol stream");
  setvbuf(out_, nullptr, _IONBF, 0);
}

Protocol::~Protocol() {
  if (out_) fclose(out_);
  else if (fd_ >= 0) platform::closeFd(fd_);
}

void Protocol::send(nlohmann::json payload) {
  std::lock_guard<std::mutex> lock(mutex_);
  payload["protocolVersion"] = 1;
  payload["jobId"] = jobId_;
  payload["seq"] = seq_++;
  std::string line = payload.dump();
  if (line.size() > 1048576) throw std::runtime_error("worker protocol frame exceeds 1 MiB");
  if (fwrite(line.data(), 1, line.size(), out_) != line.size()) throw std::runtime_error("worker protocol write failed");
  if (fputc('\n', out_) == EOF) throw std::runtime_error("worker protocol write failed");
  fflush(out_);
}

void Protocol::hello(const nlohmann::json& capabilities, std::string_view compilerVersion,
                     std::string_view extractorVersion) {
  send({{"type", "hello"},
        {"capabilities", capabilities},
        {"compilerVersion", compilerVersion},
        {"extractorVersion", extractorVersion}});
}

void Protocol::stage(std::string_view stage, std::string_view state, long long elapsedMs) {
  nlohmann::json j = {{"type", "stage"}, {"stage", stage}, {"state", state}};
  if (elapsedMs >= 0) j["elapsedMs"] = elapsedMs;
  send(std::move(j));
}

void Protocol::progress(std::string_view stage, const nlohmann::json& counts, long long elapsedMs) {
  send({{"type", "progress"}, {"stage", stage}, {"counts", counts}, {"elapsedMs", elapsedMs}});
}

void Protocol::diagnostic(const nlohmann::json& diagnostic) {
  send({{"type", "diagnostic"}, {"diagnostic", diagnostic}});
}

void Protocol::artifactReady(const nlohmann::json& artifact) {
  nlohmann::json j = artifact;
  j["type"] = "artifact.ready";
  send(std::move(j));
}

void Protocol::failed(std::string_view code, std::string_view message, bool retryable) {
  send({{"type", "failed"}, {"error", {{"code", code}, {"message", message}, {"retryable", retryable}}}});
}

void Protocol::cancelled() {
  send({{"type", "cancelled"}});
}

nlohmann::json locationJson(std::string_view displayPath, int line, int column, int endLine,
                            int endColumn) {
  nlohmann::json loc = {{"displayPath", displayPath}, {"line", line}, {"column", column}};
  if (endLine > 0) loc["endLine"] = endLine;
  if (endColumn > 0) loc["endColumn"] = endColumn;
  return loc;
}

} // namespace rtl
