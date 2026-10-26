-- Copyright 2026 Frank Gao
--
-- Licensed under the Apache License, Version 2.0 (the "License");
-- you may not use this file except in compliance with the License.
-- You may obtain a copy of the License at
--
--     http://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing, software
-- distributed under the License is distributed on an "AS IS" BASIS,
-- WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
-- See the License for the specific language governing permissions and
-- limitations under the License.

-- RTL Browser snapshot schema, version 1.
-- IDs are snapshot-local signed 64-bit integers. Public JSON must carry them as
-- decimal strings, never JavaScript numbers.
PRAGMA user_version = 1;

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE source_file (
  id           INTEGER PRIMARY KEY,
  display_path TEXT NOT NULL,
  blob_sha     TEXT NOT NULL,
  byte_length  INTEGER NOT NULL,
  line_count   INTEGER NOT NULL,
  encoding     TEXT NOT NULL DEFAULT 'utf-8',
  external     INTEGER NOT NULL DEFAULT 0,
  UNIQUE(display_path, blob_sha)
) STRICT;

CREATE TABLE source_line (
  source_id  INTEGER NOT NULL REFERENCES source_file(id),
  line_no    INTEGER NOT NULL,
  start_byte INTEGER NOT NULL,
  end_byte   INTEGER NOT NULL,
  PRIMARY KEY(source_id, line_no)
) STRICT, WITHOUT ROWID;

CREATE TABLE definition (
  id             INTEGER PRIMARY KEY,
  kind           TEXT NOT NULL,
  name           TEXT NOT NULL,
  qualified_name TEXT,
  source_id      INTEGER REFERENCES source_file(id),
  start_byte     INTEGER,
  end_byte       INTEGER,
  line           INTEGER,
  parent_id      INTEGER REFERENCES definition(id)
) STRICT;
CREATE INDEX definition_name ON definition(name, kind);
CREATE INDEX definition_source ON definition(source_id, start_byte);

CREATE TABLE scope (
  id            INTEGER PRIMARY KEY,
  parent_id     INTEGER REFERENCES scope(id),
  kind          TEXT NOT NULL,
  name          TEXT,
  definition_id INTEGER REFERENCES definition(id)
) STRICT;
CREATE INDEX scope_parent ON scope(parent_id, id);

-- Full source extent of a module/interface/program definition. The source
-- window uses this to keep only the current instance's definition active when
-- a single file contains multiple modules.
CREATE TABLE source_scope (
  id            INTEGER PRIMARY KEY,
  definition_id INTEGER REFERENCES definition(id),
  source_id     INTEGER NOT NULL REFERENCES source_file(id),
  start_byte    INTEGER NOT NULL,
  end_byte      INTEGER NOT NULL,
  line_start    INTEGER,
  line_end      INTEGER,
  kind          TEXT NOT NULL,
  name          TEXT NOT NULL
) STRICT;
CREATE INDEX source_scope_definition ON source_scope(definition_id, source_id);

-- Source ranges that are inactive for a particular instance body, such as the
-- untaken branch of a generate if. Ranges may be shared by repeated generate
-- iterations and are deduplicated by the extractor.
CREATE TABLE inactive_region (
  id                INTEGER PRIMARY KEY,
  body_id           INTEGER NOT NULL REFERENCES body(id),
  -- NULL means inactive for the whole body; otherwise the loop-generate
  -- iteration instance whose branch is inactive.
  owner_instance_id INTEGER REFERENCES instance(id),
  source_id         INTEGER NOT NULL REFERENCES source_file(id),
  start_byte        INTEGER NOT NULL,
  end_byte          INTEGER NOT NULL,
  line_start        INTEGER,
  line_end          INTEGER,
  kind              TEXT NOT NULL,
  label             TEXT
) STRICT;
CREATE INDEX inactive_region_body ON inactive_region(body_id, source_id, start_byte);
CREATE INDEX inactive_region_owner ON inactive_region(owner_instance_id, source_id);

-- Source ranges skipped by conditional preprocessing (`ifdef` / `ifndef`
-- branches). Unlike generate regions these are global to the compiled source
-- set, not to a particular instance body.
CREATE TABLE preprocessor_region (
  id         INTEGER PRIMARY KEY,
  source_id  INTEGER NOT NULL REFERENCES source_file(id),
  start_byte INTEGER NOT NULL,
  end_byte   INTEGER NOT NULL,
  line_start INTEGER,
  line_end   INTEGER,
  kind       TEXT NOT NULL,
  label      TEXT
) STRICT;
CREATE INDEX preprocessor_region_source ON preprocessor_region(source_id, start_byte);

CREATE TABLE body (
  id                  INTEGER PRIMARY KEY,
  definition_id       INTEGER REFERENCES definition(id),
  module_name         TEXT NOT NULL,
  parameter_signature TEXT,
  canonical_body_id   INTEGER REFERENCES body(id)
) STRICT;
CREATE INDEX body_definition ON body(definition_id, id);

CREATE TABLE instance (
  id                INTEGER PRIMARY KEY,
  parent_id         INTEGER REFERENCES instance(id),
  ordinal           INTEGER NOT NULL,
  name              TEXT NOT NULL,
  module_name       TEXT NOT NULL,
  definition_id     INTEGER REFERENCES definition(id),
  body_id           INTEGER NOT NULL REFERENCES body(id),
  scope_id          INTEGER REFERENCES scope(id),
  path              TEXT NOT NULL UNIQUE,
  source_id         INTEGER REFERENCES source_file(id),
  start_byte        INTEGER,
  end_byte          INTEGER,
  line              INTEGER,
  depth             INTEGER NOT NULL,
  is_instance_array INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX instance_parent_order ON instance(parent_id, ordinal, id);
CREATE INDEX instance_path ON instance(path);
CREATE INDEX instance_body ON instance(body_id);

CREATE TABLE symbol (
  id              INTEGER PRIMARY KEY,
  body_id         INTEGER REFERENCES body(id),
  scope_id        INTEGER REFERENCES scope(id),
  parent_symbol_id INTEGER REFERENCES symbol(id),
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  declared_type   TEXT,
  actual_type     TEXT,
  width           INTEGER,
  is_signed       INTEGER,
  packed_dims     TEXT,
  unpacked_dims   TEXT,
  direction       TEXT,
  default_value   TEXT,
  actual_value    TEXT,
  source_id       INTEGER REFERENCES source_file(id),
  start_byte      INTEGER,
  end_byte        INTEGER,
  line            INTEGER,
  definition_id   INTEGER REFERENCES definition(id)
) STRICT;
CREATE INDEX symbol_body ON symbol(body_id, id);
CREATE INDEX symbol_scope ON symbol(scope_id, id);
CREATE INDEX symbol_name ON symbol(name, kind);

CREATE TABLE symbol_alias (
  symbol_id       INTEGER PRIMARY KEY REFERENCES symbol(id),
  alias_symbol_id INTEGER NOT NULL REFERENCES symbol(id)
) STRICT;
CREATE INDEX symbol_alias_reverse ON symbol_alias(alias_symbol_id);

CREATE TABLE macro_definition (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  source_id  INTEGER REFERENCES source_file(id),
  start_byte INTEGER,
  end_byte   INTEGER,
  line       INTEGER,
  body       TEXT
) STRICT;
CREATE INDEX macro_definition_name ON macro_definition(name, id);

CREATE TABLE occurrence (
  id                  INTEGER PRIMARY KEY,
  body_id             INTEGER REFERENCES body(id),
  source_id           INTEGER NOT NULL REFERENCES source_file(id),
  start_byte          INTEGER NOT NULL,
  end_byte            INTEGER NOT NULL,
  kind                TEXT NOT NULL,
  role                TEXT NOT NULL,
  status              TEXT NOT NULL,
  target_symbol_id    INTEGER REFERENCES symbol(id),
  target_instance_id  INTEGER REFERENCES instance(id),
  target_source_id    INTEGER REFERENCES source_file(id),
  target_start_byte   INTEGER,
  target_end_byte     INTEGER,
  target_line         INTEGER,
  target_macro_id     INTEGER REFERENCES macro_definition(id),
  target_definition_id INTEGER REFERENCES definition(id),
  detail              TEXT
) STRICT;
CREATE INDEX occurrence_window ON occurrence(body_id, source_id, start_byte, end_byte);
CREATE INDEX occurrence_source ON occurrence(source_id, start_byte, end_byte);
CREATE INDEX occurrence_target_symbol ON occurrence(target_symbol_id);

CREATE TABLE include_link (
  id               INTEGER PRIMARY KEY,
  source_id        INTEGER REFERENCES source_file(id),
  start_byte       INTEGER,
  end_byte         INTEGER,
  target_source_id INTEGER REFERENCES source_file(id),
  is_system        INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX include_source ON include_link(source_id, start_byte);

CREATE TABLE import_link (
  id                  INTEGER PRIMARY KEY,
  body_id             INTEGER REFERENCES body(id),
  source_id           INTEGER REFERENCES source_file(id),
  start_byte          INTEGER,
  end_byte            INTEGER,
  package_name        TEXT,
  target_definition_id INTEGER REFERENCES definition(id),
  target_source_id    INTEGER REFERENCES source_file(id),
  target_start_byte   INTEGER,
  target_line         INTEGER
) STRICT;
CREATE INDEX import_source ON import_link(source_id, start_byte);

CREATE TABLE driver (
  id                 INTEGER PRIMARY KEY,
  body_id            INTEGER REFERENCES body(id),
  instance_id        INTEGER REFERENCES instance(id),
  target_symbol_id   INTEGER NOT NULL REFERENCES symbol(id),
  target_bit_lo      INTEGER,
  target_bit_hi      INTEGER,
  kind               TEXT NOT NULL,
  source_symbol_id   INTEGER REFERENCES symbol(id),
  source_instance_id INTEGER REFERENCES instance(id),
  source_bit_lo      INTEGER,
  source_bit_hi      INTEGER,
  source_id          INTEGER REFERENCES source_file(id),
  start_byte         INTEGER,
  end_byte           INTEGER,
  line               INTEGER,
  exactness          TEXT NOT NULL,
  detail             TEXT
) STRICT;
CREATE INDEX driver_body_target ON driver(body_id, target_symbol_id, id);
CREATE INDEX driver_instance_target ON driver(instance_id, target_symbol_id, id);

CREATE TABLE load_edge (
  id                 INTEGER PRIMARY KEY,
  source_body_id     INTEGER REFERENCES body(id),
  source_instance_id INTEGER REFERENCES instance(id),
  source_symbol_id   INTEGER NOT NULL REFERENCES symbol(id),
  source_bit_lo      INTEGER,
  source_bit_hi      INTEGER,
  target_body_id     INTEGER REFERENCES body(id),
  target_instance_id INTEGER REFERENCES instance(id),
  target_symbol_id   INTEGER NOT NULL REFERENCES symbol(id),
  target_bit_lo      INTEGER,
  target_bit_hi      INTEGER,
  role               TEXT NOT NULL,
  exactness          TEXT NOT NULL,
  use_source_id      INTEGER REFERENCES source_file(id),
  use_start_byte     INTEGER,
  use_end_byte       INTEGER,
  target_source_id   INTEGER REFERENCES source_file(id),
  target_start_byte  INTEGER,
  target_end_byte    INTEGER,
  detail             TEXT
) STRICT;
CREATE INDEX load_source_body ON load_edge(source_body_id, source_symbol_id, role, id);
CREATE INDEX load_source_instance ON load_edge(source_instance_id, source_symbol_id, role, id);
CREATE INDEX load_target_body ON load_edge(target_body_id, target_symbol_id, id);

CREATE TABLE macro_use (
  id            INTEGER PRIMARY KEY,
  body_id       INTEGER REFERENCES body(id),
  source_id     INTEGER REFERENCES source_file(id),
  start_byte    INTEGER,
  end_byte      INTEGER,
  definition_id INTEGER REFERENCES macro_definition(id)
) STRICT;
CREATE INDEX macro_use_source ON macro_use(source_id, start_byte);
