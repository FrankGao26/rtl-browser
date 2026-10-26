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

export type SvTokenClass =
  | "ws" | "comment" | "string" | "keyword" | "type" | "number" | "directive"
  | "macro" | "system" | "operator" | "identifier" | "escaped";

export interface SvToken {
  start: number;
  end: number;
  cls: SvTokenClass;
}

export interface SvLexState {
  blockComment: boolean;
}

const KEYWORDS = new Set([
  "module", "endmodule", "input", "output", "inout", "ref", "parameter", "localparam",
  "typedef", "struct", "union", "enum", "package", "endpackage", "import", "export",
  "interface", "endinterface", "modport", "class", "endclass", "extends", "implements",
  "generate", "endgenerate", "genvar", "always", "always_ff", "always_comb", "always_latch",
  "assign", "initial", "final", "begin", "end", "if", "else", "case", "casez", "casex",
  "endcase", "function", "endfunction", "task", "endtask", "for", "foreach", "while", "repeat",
  "forever", "return", "break", "continue", "default", "posedge", "negedge", "or", "and",
  "not", "assert", "assume", "cover", "property", "endproperty", "sequence", "endsequence",
  "covergroup", "endgroup", "virtual", "automatic", "static", "const", "wait", "disable",
  "fork", "join", "join_any", "join_none", "do", "unique", "unique0", "priority", "inside",
  "with", "type", "null", "this", "super", "new", "bind", "defparam", "specify", "endspecify",
  "table", "endtable", "primitive", "endprimitive", "program", "endprogram", "checker",
  "endchecker", "coverpoint", "cross", "bins", "rand", "randc", "iff", "matches", "tagged",
  "extern", "pure", "context", "protected", "local", "alias", "expect", "restrict", "let",
  "global", "clocking", "endclocking", "default", "disable", "force", "release", "deassign",
]);

const TYPES = new Set([
  "logic", "bit", "reg", "wire", "tri", "wand", "wor", "uwire", "int", "integer",
  "byte", "shortint", "longint", "time", "realtime", "real", "shortreal", "string",
  "chandle", "event", "void", "signed", "unsigned", "var", "supply0", "supply1",
]);

function isIdStart(c: string): boolean { return /[A-Za-z_$]/.test(c); }
function isId(c: string): boolean { return /[A-Za-z0-9_$]/.test(c); }
function isDigit(c: string): boolean { return c >= "0" && c <= "9"; }

export function lexSvLine(line: string, state: SvLexState): { tokens: SvToken[]; state: SvLexState } {
  const tokens: SvToken[] = [];
  let i = 0;
  const push = (start: number, end: number, cls: SvTokenClass) => {
    if (end > start) tokens.push({ start, end, cls });
  };
  while (i < line.length) {
    if (state.blockComment) {
      const end = line.indexOf("*/", i);
      if (end < 0) {
        push(i, line.length, "comment");
        i = line.length;
      } else {
        push(i, end + 2, "comment");
        i = end + 2;
        state = { blockComment: false };
      }
      continue;
    }
    const c = line[i];
    if (/\s/.test(c)) {
      let j = i + 1;
      while (j < line.length && /\s/.test(line[j])) j++;
      push(i, j, "ws");
      i = j;
      continue;
    }
    if (line.startsWith("//", i)) {
      push(i, line.length, "comment");
      i = line.length;
      continue;
    }
    if (line.startsWith("/*", i)) {
      const end = line.indexOf("*/", i + 2);
      if (end < 0) {
        push(i, line.length, "comment");
        i = line.length;
        state = { blockComment: true };
      } else {
        push(i, end + 2, "comment");
        i = end + 2;
      }
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === "\\") { j += 2; continue; }
        if (line[j] === '"') { j++; break; }
        j++;
      }
      push(i, Math.min(j, line.length), "string");
      i = Math.min(j, line.length);
      continue;
    }
    if (c === "`") {
      let j = i + 1;
      while (j < line.length && isId(line[j])) j++;
      push(i, j, "directive");
      i = j;
      continue;
    }
    if (c === "$") {
      let j = i + 1;
      while (j < line.length && isId(line[j])) j++;
      push(i, j, "system");
      i = j;
      continue;
    }
    if (c === "\\") {
      let j = i + 1;
      while (j < line.length && !/\s/.test(line[j])) j++;
      push(i, j, "escaped");
      i = j;
      continue;
    }
    // Based numbers and ordinary decimal/time literals.
    if (isDigit(c) || (c === "'" && i + 1 < line.length)) {
      let j = i;
      if (c === "'") {
        j++;
        if (line[j] === "s" || line[j] === "S") j++;
        if (/[bBoOdDhH]/.test(line[j] ?? "")) {
          j++;
          while (j < line.length && /[0-9a-fA-FxXzZ?_]/.test(line[j])) j++;
        } else {
          while (j < line.length && /[01xXzZ?]/.test(line[j])) j++;
        }
      } else {
        while (j < line.length && /[0-9_]/.test(line[j])) j++;
        if (line[j] === "'") {
          j++;
          if (line[j] === "s" || line[j] === "S") j++;
          if (/[bBoOdDhH]/.test(line[j] ?? "")) {
            j++;
            while (j < line.length && /[0-9a-fA-FxXzZ?_]/.test(line[j])) j++;
          }
        } else if (line[j] === "." && isDigit(line[j + 1] ?? "")) {
          j++;
          while (j < line.length && /[0-9_]/.test(line[j])) j++;
        }
      }
      push(i, j, "number");
      i = j;
      continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < line.length && isId(line[j])) j++;
      const word = line.slice(i, j);
      push(i, j, KEYWORDS.has(word) ? "keyword" : TYPES.has(word) ? "type" : "identifier");
      i = j;
      continue;
    }
    // Operators and punctuation, grouping VHDL-style multi-character operators.
    let j = i + 1;
    while (j < line.length && /[=!<>+\-*/%&|^~?:]/.test(line[j])) j++;
    push(i, j, "operator");
    i = j;
  }
  return { tokens, state };
}
