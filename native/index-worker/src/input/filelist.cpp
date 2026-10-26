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

#include "filelist.h"

#include <cctype>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <optional>
#include <sstream>

#include "../platform.h"

namespace rtl {
namespace fs = std::filesystem;

namespace {

struct Token {
  std::string text;
  int line = 1;
};

std::vector<Token> tokenize(const std::string& text, const std::string& display) {
  std::vector<Token> out;
  std::string cur;
  int line = 1;
  int tokenLine = 1;
  bool inQuote = false;
  char quote = 0;
  for (size_t i = 0; i < text.size(); i++) {
    char c = text[i];
    if (!inQuote && c == '\\' && i + 1 < text.size() && (text[i + 1] == '\n' || text[i + 1] == '\r')) {
      if (text[i + 1] == '\r' && i + 2 < text.size() && text[i + 2] == '\n') i += 2;
      else i += 1;
      line++;
      continue;
    }
    if (!inQuote && c == '/' && i + 1 < text.size() && text[i + 1] == '/') {
      while (i < text.size() && text[i] != '\n') i++;
      line++;
      continue;
    }
    if (!inQuote && c == '#' && cur.empty()) {
      while (i < text.size() && text[i] != '\n') i++;
      line++;
      continue;
    }
    if (!inQuote && (c == '"' || c == '\'')) {
      if (cur.empty()) tokenLine = line;
      inQuote = true;
      quote = c;
      continue;
    }
    if (inQuote) {
      if (c == quote) {
        inQuote = false;
        continue;
      }
      if (c == '\\' && i + 1 < text.size()) {
        const char n = text[i + 1];
        // Filelist quoting must preserve Windows separators. Only consume the
        // backslash when it escapes a quote or another backslash.
        if (n == '"' || n == '\'' || n == '\\') {
          cur.push_back(n);
          i++;
          continue;
        }
        cur.push_back(c);
        continue;
      }
      if (c == '\n') line++;
      cur.push_back(c);
      continue;
    }
    if (std::isspace(static_cast<unsigned char>(c))) {
      if (!cur.empty()) {
        out.push_back({cur, tokenLine});
        cur.clear();
      }
      if (c == '\n') line++;
      continue;
    }
    if (cur.empty()) tokenLine = line;
    cur.push_back(c);
  }
  if (inQuote) throw FilelistError(display + ": unterminated quoted string");
  if (!cur.empty()) out.push_back({cur, tokenLine});
  return out;
}

std::string envValue(const std::string& name) {
  const auto value = platform::getEnv(name);
  if (!value) throw FilelistError("environment variable is not set: " + name);
  return *value;
}

} // namespace

FilelistNormalizer::FilelistNormalizer(std::string projectRoot, std::string outputDir)
    : projectRoot_(std::move(projectRoot)), outputDir_(std::move(outputDir)) {}

std::string FilelistNormalizer::expandEnv(const std::string& text) {
  std::string out = text;
  if (out == "~" || out.rfind("~/", 0) == 0 || out.rfind("~\\", 0) == 0) {
    auto home = platform::getEnv("HOME");
    if (!home) home = platform::getEnv("USERPROFILE");
    if (!home) throw FilelistError("HOME/USERPROFILE is not set");
    out = *home + out.substr(1);
  }
  for (size_t i = 0; i < out.size();) {
    if (out[i] == '%') {
      size_t j = out.find('%', i + 1);
      if (j != std::string::npos && j > i + 1) {
        std::string name = out.substr(i + 1, j - i - 1);
        bool valid = !name.empty();
        for (char c : name) if (!(std::isalnum(static_cast<unsigned char>(c)) || c == '_')) valid = false;
        if (valid) {
          out.replace(i, j - i + 1, envValue(name));
          continue;
        }
      }
      i++;
      continue;
    }
    if (out[i] != '$') { i++; continue; }
    size_t start = i;
    std::string name;
    if (i + 1 < out.size() && out[i + 1] == '{') {
      size_t j = out.find('}', i + 2);
      if (j != std::string::npos) {
        name = out.substr(i + 2, j - i - 2);
        if (!name.empty()) {
          out.replace(start, j - start + 1, envValue(name));
          continue;
        }
      }
    } else {
      size_t j = i + 1;
      while (j < out.size() && (std::isalnum(static_cast<unsigned char>(out[j])) || out[j] == '_')) j++;
      name = out.substr(i + 1, j - i - 1);
      if (!name.empty()) {
        out.replace(start, j - start, envValue(name));
        continue;
      }
    }
    i++;
  }
  return out;
}

std::string FilelistNormalizer::resolvePath(const std::string& raw, const std::string& label,
                                            bool directory) {
  std::string expanded = expandEnv(raw);
  fs::path p = platform::fromUtf8(expanded);
  if (!p.is_absolute()) p = platform::fromUtf8(projectRoot_) / p;
  std::error_code ec;
  fs::path canon = fs::weakly_canonical(p, ec);
  if (ec) throw FilelistError(label + " cannot be resolved: " + raw);
  if (!fs::exists(canon, ec) || ec) throw FilelistError(label + " does not exist: " + raw);
  if (directory) {
    if (!fs::is_directory(canon, ec) || ec) throw FilelistError(label + " is not a directory: " + raw);
  } else {
    if (!fs::is_regular_file(canon, ec) || ec) throw FilelistError(label + " is not a file: " + raw);
  }
  if (!platform::isReadable(canon)) throw FilelistError(label + " is not readable: " + raw);
  return platform::genericUtf8(canon);
}

std::string FilelistNormalizer::quoteToken(const std::string& token) const {
  bool needs = false;
  for (char c : token) if (std::isspace(static_cast<unsigned char>(c)) || c == '"' || c == '\\') needs = true;
  if (!needs) return token;
  std::string out = "\"";
  for (char c : token) {
    if (c == '"' || c == '\\') out.push_back('\\');
    out.push_back(c);
  }
  out.push_back('"');
  return out;
}

std::string FilelistNormalizer::writeTokens(const std::vector<std::string>& tokens) {
  std::string name = "normalized-" + std::to_string(++generated_) + ".f";
  fs::path file = platform::fromUtf8(outputDir_) / name;
  std::ofstream out(file, std::ios::binary);
  if (!out) throw FilelistError("cannot write normalized filelist");
  for (const auto& token : tokens) out << quoteToken(token) << "\n";
  out.flush();
  if (!out) throw FilelistError("cannot flush normalized filelist");
  return platform::toUtf8(file);
}

void FilelistNormalizer::readFilelist(const std::string& file, std::vector<std::string>& out,
                                      std::vector<std::string>& stack) {
  std::string canon = resolvePath(file, "filelist", false);
  for (const auto& active : stack) {
    if (platform::samePath(platform::fromUtf8(active), platform::fromUtf8(canon))) {
      throw FilelistError("filelist recursion detected: " + file);
    }
  }
  if (stack.size() >= 32) throw FilelistError("filelist nesting is too deep: " + file);
  std::ifstream in(platform::fromUtf8(canon), std::ios::binary);
  if (!in) throw FilelistError("cannot read filelist: " + file);
  std::stringstream ss;
  ss << in.rdbuf();
  auto tokens = tokenize(ss.str(), file);
  stack.push_back(canon);
  for (size_t i = 0; i < tokens.size(); i++) {
    const std::string& tok = tokens[i].text;
    const std::string where = file + ":" + std::to_string(tokens[i].line);
    if (tok == "-f" || tok == "-F") {
      if (i + 1 >= tokens.size()) throw FilelistError(where + ": " + tok + " requires a filelist path");
      readFilelist(tokens[++i].text, out, stack);
      continue;
    }
    if (tok.rfind("-f", 0) == 0 || tok.rfind("-F", 0) == 0) {
      readFilelist(tok.substr(2), out, stack);
      continue;
    }
    if (tok.rfind("+incdir+", 0) == 0) {
      std::string dirs = tok.substr(8);
      std::string rebuilt = "+incdir+";
      size_t start = 0;
      while (true) {
        size_t plus = dirs.find('+', start);
        std::string item = dirs.substr(start, plus == std::string::npos ? std::string::npos : plus - start);
        if (!item.empty()) rebuilt += resolvePath(item, "include directory", true);
        if (plus == std::string::npos) break;
        rebuilt += "+";
        start = plus + 1;
      }
      out.push_back(rebuilt);
      continue;
    }
    if (tok.rfind("+define+", 0) == 0) { out.push_back(tok); continue; }
    if (tok == "-D" || tok == "-G") {
      if (i + 1 >= tokens.size()) throw FilelistError(where + ": " + tok + " requires a value");
      out.push_back(tok);
      out.push_back(tokens[++i].text);
      continue;
    }
    if (tok == "-I" || tok == "-y" || tok == "-v") {
      if (i + 1 >= tokens.size()) throw FilelistError(where + ": " + tok + " requires a path");
      bool dir = tok != "-v";
      out.push_back(tok);
      out.push_back(resolvePath(tokens[++i].text, tok == "-v" ? "library" : "path", dir));
      continue;
    }
    if (tok.rfind("-I", 0) == 0 && tok.size() > 2) {
      out.push_back("-I" + resolvePath(tok.substr(2), "include directory", true));
      continue;
    }
    if (tok.rfind("-y", 0) == 0 && tok.size() > 2) {
      out.push_back("-y" + resolvePath(tok.substr(2), "library directory", true));
      continue;
    }
    if (tok.rfind("-v", 0) == 0 && tok.size() > 2) {
      out.push_back("-v" + resolvePath(tok.substr(2), "library", false));
      continue;
    }
    if (!tok.empty() && (tok[0] == '-' || tok[0] == '+')) {
      out.push_back(tok);
      continue;
    }
    out.push_back(resolvePath(tok, "source file", false));
  }
  stack.pop_back();
}

std::string FilelistNormalizer::normalizeFilelist(const std::string& filelistPath) {
  std::vector<std::string> tokens;
  std::vector<std::string> stack;
  readFilelist(filelistPath, tokens, stack);
  return writeTokens(tokens);
}

std::string FilelistNormalizer::normalizeSources(const std::vector<std::string>& sourcePaths) {
  std::vector<std::string> tokens;
  for (const auto& source : sourcePaths) tokens.push_back(resolvePath(source, "source file", false));
  return writeTokens(tokens);
}

} // namespace rtl
