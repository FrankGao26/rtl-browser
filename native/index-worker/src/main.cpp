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

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json.hpp>

#include <slang/analysis/AnalysisManager.h>
#include <slang/ast/Compilation.h>
#include <slang/driver/Driver.h>
#include <slang/text/SourceManager.h>
#include <slang/util/VersionInfo.h>

#include "compiler/diagnostics.h"
#include "extract/indexer.h"
#include "extract/source_store.h"
#include "input/path_policy.h"
#include "input/filelist.h"
#include "platform.h"
#include "protocol.h"
#include "sha256.h"
#include "store/index_writer.h"

using nlohmann::json;

namespace rtl {
namespace {

struct Args {
  std::string config;
  std::string output;
  std::string schema;
  std::string jobId;
};

Args parseArgs(const std::vector<std::string>& argv) {
  Args a;
  for (size_t i = 1; i < argv.size(); i++) {
    const std::string& k = argv[i];
    auto value = [&]() -> std::string {
      if (i + 1 >= argv.size()) throw std::runtime_error("missing value for " + k);
      return argv[++i];
    };
    if (k == "--config") a.config = value();
    else if (k == "--output") a.output = value();
    else if (k == "--schema") a.schema = value();
    else if (k == "--job-id") a.jobId = value();
    else if (k == "--help" || k == "-h") {
      std::printf("index-worker --config FILE --output DIR --schema FILE --job-id ID\n");
      std::exit(0);
    } else {
      throw std::runtime_error("unknown argument: " + k);
    }
  }
  if (a.config.empty() || a.output.empty() || a.schema.empty() || a.jobId.empty()) {
    throw std::runtime_error("--config, --output, --schema and --job-id are required");
  }
  return a;
}

json readJson(const std::filesystem::path& path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) throw std::runtime_error("cannot read " + platform::toUtf8(path));
  return json::parse(in);
}

std::string readText(const std::filesystem::path& path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) throw std::runtime_error("cannot read " + platform::toUtf8(path));
  return std::string(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
}

std::string getString(const json& j, const char* key) {
  if (!j.contains(key) || !j[key].is_string()) throw std::runtime_error(std::string("config field is missing or not a string: ") + key);
  return j[key].get<std::string>();
}

std::vector<std::string> getStringArray(const json& j, const char* key, bool required = false) {
  if (!j.contains(key) || !j[key].is_array()) {
    if (required) throw std::runtime_error(std::string("config field is missing or not an array: ") + key);
    return {};
  }
  std::vector<std::string> out;
  for (const auto& v : j[key]) {
    if (!v.is_string()) throw std::runtime_error(std::string("array entry is not a string: ") + key);
    out.push_back(v.get<std::string>());
  }
  return out;
}

std::string nowIso() {
  std::time_t t = std::time(nullptr);
  std::tm tm = platform::gmtime(t);
  char buf[64];
  std::strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &tm);
  return buf;
}

void writeJsonAtomic(const std::filesystem::path& file, const json& value) {
  std::filesystem::create_directories(file.parent_path());
  auto tmp = file;
  tmp += ".tmp";
  {
    std::ofstream out(tmp, std::ios::binary);
    if (!out) throw std::runtime_error("cannot write manifest");
    out << value.dump(2) << "\n";
    out.flush();
    if (!out) throw std::runtime_error("cannot flush manifest");
  }
  std::error_code ec;
#ifdef _WIN32
  // std::filesystem::rename does not reliably replace an existing file on
  // Windows. The candidate directory is private to this worker, so replacing
  // the previous manifest here remains safe.
  std::filesystem::remove(file, ec);
  ec.clear();
#endif
  std::filesystem::rename(tmp, file, ec);
  if (ec) throw std::runtime_error("cannot publish manifest: " + ec.message());
}

void validateDatabase(IndexWriter& writer, const SourceStore& sources) {
  auto& db = writer.db();
  {
    auto stmt = db.prepare("PRAGMA integrity_check");
    if (!stmt.step() || stmt.columnText(0) != "ok") throw std::runtime_error("SQLite integrity_check failed");
  }
  {
    auto stmt = db.prepare("PRAGMA foreign_key_check");
    if (stmt.step()) throw std::runtime_error("SQLite foreign_key_check failed");
  }
  auto scalar = [&](const char* sql) -> int64_t {
    auto stmt = db.prepare(sql);
    if (!stmt.step()) return 0;
    return stmt.columnInt64(0);
  };
  if (scalar("SELECT COUNT(*) FROM occurrence o JOIN source_file s ON s.id=o.source_id WHERE o.start_byte<0 OR o.end_byte>s.byte_length") != 0)
    throw std::runtime_error("occurrence span out of bounds");
  if (scalar("SELECT COUNT(*) FROM driver d WHERE d.target_symbol_id NOT IN (SELECT id FROM symbol)") != 0)
    throw std::runtime_error("driver target symbol missing");
  if (scalar("SELECT COUNT(*) FROM load_edge l WHERE l.source_symbol_id NOT IN (SELECT id FROM symbol) OR l.target_symbol_id NOT IN (SELECT id FROM symbol)") != 0)
    throw std::runtime_error("load endpoint symbol missing");
  if (scalar("SELECT COUNT(*) FROM instance i WHERE i.parent_id IS NOT NULL AND i.parent_id NOT IN (SELECT id FROM instance)") != 0)
    throw std::runtime_error("instance parent missing");
  // A bounded recursive check catches cycles without walking an enormous tree.
  if (scalar("WITH RECURSIVE anc(id,parent,depth) AS ("
             " SELECT id,parent_id,0 FROM instance WHERE parent_id IS NOT NULL"
             " UNION ALL SELECT a.id,i.parent_id,a.depth+1 FROM anc a JOIN instance i ON i.id=a.parent WHERE a.depth<512)"
             " SELECT COUNT(*) FROM anc WHERE depth>=512") != 0)
    throw std::runtime_error("instance hierarchy is cyclic or too deep");
}

std::string sourceManifestHash(const SourceStore& sources) {
  std::string s;
  for (const auto& info : sources.all()) {
    s += info->displayPath;
    s += "\0";
    s += info->sha;
    s += "\0";
  }
  return sha256Hex(s);
}

} // namespace
} // namespace rtl

int runMain(const std::vector<std::string>& argv) {
  using namespace rtl;
  std::unique_ptr<Protocol> protocol;
  try {
    Args args = parseArgs(argv);
    args.config = platform::toUtf8(std::filesystem::absolute(platform::fromUtf8(args.config)));
    args.output = platform::toUtf8(std::filesystem::absolute(platform::fromUtf8(args.output)));
    args.schema = platform::toUtf8(std::filesystem::absolute(platform::fromUtf8(args.schema)));
    protocol = std::make_unique<Protocol>(args.jobId);
    json config = readJson(platform::fromUtf8(args.config));
    std::string projectId = getString(config, "projectId");
    std::string projectRoot = getString(config, "projectRoot");
    std::string workingDirectory = getString(config, "workingDirectory");
    std::string topModule = getString(config, "topModule");
    std::string inputMode = getString(config, "inputMode");
    std::string configDigest = getString(config, "configDigest");
    auto sourceRoots = getStringArray(config, "sourceRoots", true);
    auto includeRoots = getStringArray(config, "includeRoots");
    auto libraries = getStringArray(config, "libraries");
    auto sourcePaths = getStringArray(config, "sourcePaths");
    auto warningOptions = getStringArray(config, "warningOptions");
    bool singleUnit = config.value("singleUnit", false);
    bool warningAsError = config.value("warningAsError", false);
    int threads = config.value("threads", 1);
    std::string language = config.contains("language") && config["language"].is_string()
                               ? config["language"].get<std::string>() : "";

    std::filesystem::create_directories(platform::fromUtf8(args.output));
    std::error_code ec;
    std::filesystem::remove(platform::fromUtf8(args.output) / "index.sqlite", ec);

    PathPolicy paths(workingDirectory, sourceRoots, projectRoot);
    if (!platform::setCurrentDirectory(platform::fromUtf8(workingDirectory))) {
      throw std::runtime_error("cannot chdir to working directory");
    }

    protocol->hello(json::array({"hierarchy", "resolved-symbols", "types-values",
                                 "drivers-bit-mapping", "loads-direct-dependencies",
                                 "preprocessor-provenance", "definition-links",
                                 "source-snapshot"}),
                    std::string(slang::VersionInfo::getVersionString()), "0.9.11");
    protocol->stage("COMPILING", "start");

    std::string normalizedFilelist;
    {
      FilelistNormalizer normalizer(projectRoot,
          platform::toUtf8(platform::fromUtf8(args.config).parent_path()));
      if (inputMode == "filelist") {
        normalizedFilelist = normalizer.normalizeFilelist(getString(config, "filelistPath"));
      } else if (inputMode == "sources") {
        normalizedFilelist = normalizer.normalizeSources(sourcePaths);
      } else {
        throw FilelistError("unsupported inputMode");
      }
    }

    slang::driver::Driver driver;
    driver.addStandardArgs();
    auto diagClient = std::make_shared<StreamingDiagnosticClient>(*protocol, paths, "COMPILING");
    driver.diagEngine.clearClients();
    driver.diagEngine.addClient(diagClient);

    std::vector<std::string> argsVec = {"index-worker", "--top", topModule, "--threads",
                                        std::to_string(threads), "--disable-instance-caching",
                                        "--error-limit", "1000"};
    if (!language.empty()) { argsVec.push_back("--std"); argsVec.push_back(language); }
    if (singleUnit) argsVec.push_back("--single-unit");
    if (config.contains("defines") && config["defines"].is_array()) {
      for (const auto& d : config["defines"]) {
        if (!d.is_object() || !d.contains("name") || !d["name"].is_string()) continue;
        std::string def = "-D" + d["name"].get<std::string>();
        if (d.contains("value") && d["value"].is_string()) def += "=" + d["value"].get<std::string>();
        argsVec.push_back(std::move(def));
      }
    }
    for (const auto& inc : includeRoots) argsVec.push_back("+incdir+" + inc);
    for (const auto& warning : warningOptions) { argsVec.push_back("-W"); argsVec.push_back(warning); }
    for (const auto& lib : libraries) { argsVec.push_back("-v"); argsVec.push_back(lib); }
    if (config.contains("parameters") && config["parameters"].is_array()) {
      for (const auto& p : config["parameters"]) {
        if (!p.is_object() || !p.contains("name") || !p.contains("value")) continue;
        argsVec.push_back("-G" + p["name"].get<std::string>() + "=" + p["value"].get<std::string>());
      }
    }
    argsVec.push_back("-f");
    argsVec.push_back(normalizedFilelist);

    std::vector<char*> cargs;
    cargs.reserve(argsVec.size());
    for (auto& s : argsVec) cargs.push_back(s.data());
    if (!driver.parseCommandLine(int(cargs.size()), cargs.data())) {
      protocol->stage("COMPILING", "fail");
      protocol->failed("INVALID_INPUT", "slang rejected the build arguments", false);
      return 1;
    }
    if (!driver.processOptions()) {
      protocol->stage("COMPILING", "fail");
      protocol->failed("COMPILER_ERROR", "slang failed while processing options", false);
      return 1;
    }
    if (!driver.parseAllSources()) {
      protocol->stage("COMPILING", "fail");
      protocol->failed("COMPILER_ERROR", "slang failed to parse the source closure", false);
      return 1;
    }
    auto compilation = driver.createCompilation();
    if (!compilation) {
      protocol->stage("COMPILING", "fail");
      protocol->failed("COMPILER_ERROR", "slang did not produce a compilation", false);
      return 1;
    }
    driver.reportCompilation(*compilation, true);
    std::unique_ptr<slang::analysis::AnalysisManager> analysis = driver.runAnalysis(*compilation);
    bool ok = driver.reportDiagnostics(true);
    if (warningAsError && driver.diagEngine.getNumWarnings() > 0) {
      protocol->diagnostic({{"sequence", 1000000}, {"stage", "COMPILING"}, {"severity", "error"},
                            {"code", "warning-as-error"},
                            {"message", "warnings are treated as errors by the build configuration"}});
      ok = false;
    }
    if (!ok || driver.diagEngine.getNumErrors() > 0) {
      protocol->stage("COMPILING", "fail");
      protocol->failed("COMPILER_ERROR", "compilation failed; see Compile diagnostics", false);
      return 1;
    }
    protocol->stage("COMPILING", "finish");

    protocol->stage("EXTRACTING", "start");
    IndexWriter writer(args.output, args.schema);
    SourceStore sources;
    std::vector<std::string> excludedInputs;
    if (config.contains("filelistPath") && config["filelistPath"].is_string())
      excludedInputs.push_back(config["filelistPath"].get<std::string>());
    excludedInputs.push_back(normalizedFilelist);
    sources.capture(writer, *compilation->getSourceManager(), paths, args.output, excludedInputs);
    protocol->stage("EXTRACTING", "finish");
    protocol->stage("INDEXING", "start");
    Indexer indexer(*compilation, *compilation->getSourceManager(), *analysis, writer, sources, paths);
    indexer.run();
    protocol->stage("INDEXING", "finish");
    protocol->stage("VALIDATING", "start");
    validateDatabase(writer, sources);
    writer.commit();
    writer.close();
    protocol->stage("VALIDATING", "finish");

    std::string indexSha = sha256Hex(readText(platform::fromUtf8(args.output) / "index.sqlite"));
    std::string compilerCommit = std::string(slang::VersionInfo::getHash());
    const std::string pinnedCompilerCommit = RTL_SLANG_COMMIT;
    const bool fullPin = pinnedCompilerCommit.size() == 40 &&
        std::all_of(pinnedCompilerCommit.begin(), pinnedCompilerCommit.end(), [](char c) {
          return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
        });
    // slang can report an abbreviated Git hash. Expand it only when it agrees
    // with our verified build pin; never replace a different compiler revision.
    if (compilerCommit.empty() || compilerCommit == "0" ||
        (fullPin && compilerCommit.size() >= 7 && compilerCommit.size() < 40 &&
         pinnedCompilerCommit.starts_with(compilerCommit))) {
      compilerCommit = pinnedCompilerCommit;
    }
    std::string snapshotMaterial = configDigest + "\n" + std::string(slang::VersionInfo::getVersionString()) +
                                   "\n" + compilerCommit + "\n0.9.11\n" + sourceManifestHash(sources);
    std::string snapshotId = "s_" + sha256Hex(snapshotMaterial).substr(0, 16);
    json sourceList = json::array();
    for (const auto& info : sources.all()) {
      sourceList.push_back({{"sourceId", std::to_string(info->id)},
                            {"displayPath", info->displayPath},
                            {"sha256", info->sha},
                            {"bytes", info->data.size()},
                            {"encoding", "utf-8"}});
    }
    json counts = indexer.counts();
    json manifest = {
        {"schemaVersion", 1},
        {"protocolVersion", 1},
        {"extractorVersion", "0.9.11"},
        {"compilerVersion", std::string(slang::VersionInfo::getVersionString())},
        {"compilerCommit", compilerCommit},
        {"snapshotId", snapshotId},
        {"projectId", projectId},
        {"jobId", args.jobId},
        {"createdAt", nowIso()},
        {"configDigest", configDigest},
        {"rootInstanceId", std::to_string(indexer.rootInstanceId())},
        {"rootPath", indexer.rootPath()},
        {"topModule", topModule},
        {"capabilities", indexer.capabilities()},
        {"capabilityComplete", indexer.capabilityComplete()},
        {"counts", counts},
        {"sources", sourceList},
        {"indexSha256", indexSha},
        {"status", "READY"},
    };
    auto manifestPath = platform::fromUtf8(args.output) / "manifest.json";
    writeJsonAtomic(manifestPath, manifest);
    std::string manifestSha = sha256Hex(readText(manifestPath));
    protocol->artifactReady({{"manifestPath", "manifest.json"},
                             {"manifestSha256", manifestSha},
                             {"snapshotId", snapshotId},
                             {"counts", counts},
                             {"capabilities", indexer.capabilityComplete()}});
    return 0;
  } catch (const FilelistError& err) {
    std::fprintf(stderr, "index-worker: %s\n", err.what());
    if (protocol) {
      try {
        protocol->diagnostic({{"sequence", 900000}, {"stage", "COMPILING"}, {"severity", "error"},
                              {"code", "filelist-error"}, {"message", err.what()}});
        protocol->stage("COMPILING", "fail");
        protocol->failed("INVALID_INPUT", err.what(), false);
      } catch (...) {}
    }
    return 1;
  } catch (const std::exception& err) {
    std::fprintf(stderr, "index-worker: %s\n", err.what());
    if (protocol) {
      try { protocol->failed("INTERNAL_ERROR", err.what(), false); } catch (...) {}
    }
    return 2;
  }
}

#ifdef _WIN32
int wmain(int argc, wchar_t** argv) {
  return runMain(rtl::platform::wideArgsToUtf8(argc, argv));
}
#else
int main(int argc, char** argv) {
  return runMain(std::vector<std::string>(argv, argv + argc));
}
#endif
