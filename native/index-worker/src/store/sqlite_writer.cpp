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

#include "sqlite_writer.h"

#include <sqlite3.h>

#include <filesystem>

#include "../platform.h"

namespace rtl {

static std::string errMsg(sqlite3* db, const char* what) {
  std::string msg = what ? what : "sqlite error";
  if (db) {
    msg += ": ";
    msg += sqlite3_errmsg(db);
  }
  return msg;
}

Stmt::Stmt(sqlite3* db, std::string_view sql) : db_(db) {
  int rc = sqlite3_prepare_v2(db, sql.data(), int(sql.size()), &stmt_, nullptr);
  if (rc != SQLITE_OK) throw SqliteError(errMsg(db, "prepare failed"));
}

Stmt::~Stmt() {
  if (stmt_) sqlite3_finalize(stmt_);
}

Stmt::Stmt(Stmt&& other) noexcept : db_(other.db_), stmt_(other.stmt_) {
  other.db_ = nullptr;
  other.stmt_ = nullptr;
}

Stmt& Stmt::operator=(Stmt&& other) noexcept {
  if (this != &other) {
    if (stmt_) sqlite3_finalize(stmt_);
    db_ = other.db_;
    stmt_ = other.stmt_;
    other.db_ = nullptr;
    other.stmt_ = nullptr;
  }
  return *this;
}

Stmt& Stmt::bind(int index, int64_t value) {
  int rc = sqlite3_bind_int64(stmt_, index, value);
  if (rc != SQLITE_OK) throw SqliteError(errMsg(db_, "bind int failed"));
  return *this;
}

Stmt& Stmt::bind(int index, std::string_view value) {
  int rc = sqlite3_bind_text(stmt_, index, value.data(), int(value.size()), SQLITE_TRANSIENT);
  if (rc != SQLITE_OK) throw SqliteError(errMsg(db_, "bind text failed"));
  return *this;
}

Stmt& Stmt::bindNull(int index) {
  int rc = sqlite3_bind_null(stmt_, index);
  if (rc != SQLITE_OK) throw SqliteError(errMsg(db_, "bind null failed"));
  return *this;
}

bool Stmt::step() {
  int rc = sqlite3_step(stmt_);
  if (rc == SQLITE_ROW) return true;
  if (rc == SQLITE_DONE) return false;
  throw SqliteError(errMsg(db_, "step failed"));
}

void Stmt::reset() {
  sqlite3_reset(stmt_);
  sqlite3_clear_bindings(stmt_);
}

void Stmt::exec() {
  while (step()) {
  }
  reset();
}

std::string Stmt::columnText(int index) const {
  const unsigned char* p = sqlite3_column_text(stmt_, index);
  if (!p) return {};
  int n = sqlite3_column_bytes(stmt_, index);
  return std::string(reinterpret_cast<const char*>(p), size_t(n));
}

int64_t Stmt::columnInt64(int index) const {
  return sqlite3_column_int64(stmt_, index);
}

SqliteDb::SqliteDb(const std::string& file) {
  std::error_code ec;
  auto parent = platform::fromUtf8(file).parent_path();
  if (!parent.empty()) std::filesystem::create_directories(parent, ec);
  int rc = sqlite3_open_v2(file.c_str(), &db_, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nullptr);
  if (rc != SQLITE_OK) {
    std::string msg = errMsg(db_, "open failed");
    if (db_) sqlite3_close(db_);
    db_ = nullptr;
    throw SqliteError(msg);
  }
  sqlite3_busy_timeout(db_, 5000);
  sqlite3_extended_result_codes(db_, 1);
}

SqliteDb::~SqliteDb() {
  if (db_) sqlite3_close(db_);
}

void SqliteDb::exec(std::string_view sql) {
  char* err = nullptr;
  int rc = sqlite3_exec(db_, std::string(sql).c_str(), nullptr, nullptr, &err);
  if (rc != SQLITE_OK) {
    std::string msg = err ? err : "sqlite exec failed";
    sqlite3_free(err);
    throw SqliteError(msg);
  }
}

Stmt SqliteDb::prepare(std::string_view sql) {
  return Stmt(db_, sql);
}

void SqliteDb::begin() { exec("BEGIN IMMEDIATE;"); }
void SqliteDb::commit() { exec("COMMIT;"); }
void SqliteDb::rollback() { try { exec("ROLLBACK;"); } catch (...) {} }

void SqliteDb::close() {
  if (db_) {
    sqlite3_close(db_);
    db_ = nullptr;
  }
}

std::string sqlQuote(std::string_view value) {
  std::string out;
  out.reserve(value.size() + 2);
  out.push_back('\'');
  for (char c : value) {
    if (c == '\'') out.push_back('\'');
    out.push_back(c);
  }
  out.push_back('\'');
  return out;
}

} // namespace rtl
