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
#include <stdexcept>
#include <string>
#include <string_view>

struct sqlite3;
struct sqlite3_stmt;

namespace rtl {

class SqliteError : public std::runtime_error {
public:
  explicit SqliteError(const std::string& msg) : std::runtime_error(msg) {}
};

class Stmt {
public:
  Stmt() = default;
  Stmt(sqlite3* db, std::string_view sql);
  ~Stmt();
  Stmt(const Stmt&) = delete;
  Stmt& operator=(const Stmt&) = delete;
  Stmt(Stmt&& other) noexcept;
  Stmt& operator=(Stmt&& other) noexcept;

  Stmt& bind(int index, int64_t value);
  Stmt& bind(int index, std::string_view value);
  Stmt& bindNull(int index);
  bool step();
  void reset();
  void exec();
  std::string columnText(int index) const;
  int64_t columnInt64(int index) const;

private:
  sqlite3* db_ = nullptr;
  sqlite3_stmt* stmt_ = nullptr;
};

class SqliteDb {
public:
  explicit SqliteDb(const std::string& file);
  ~SqliteDb();
  SqliteDb(const SqliteDb&) = delete;
  SqliteDb& operator=(const SqliteDb&) = delete;

  void exec(std::string_view sql);
  Stmt prepare(std::string_view sql);
  void begin();
  void commit();
  void rollback();
  void close();
  sqlite3* raw() { return db_; }

private:
  sqlite3* db_ = nullptr;
};

std::string sqlQuote(std::string_view value);

} // namespace rtl
