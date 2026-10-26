# common_cells advanced SystemVerilog fixture

Upstream: https://github.com/pulp-platform/common_cells

Pinned commit: `e73baaec2ca665cd80c3c384e9258e35242b829c`

Selected files under `rtl/` and `include/` (including the deprecated register
macro include required by `registers.svh`) are copied unmodified from the upstream
repository. The filelist adds the include directory and uses paths relative to
this directory. Upstream license: Solderpad Hardware License 0.51 (see
`licenses/LICENSE`).

The top used by the smoke test is `cc_addr_decode`, which exercises packed
structs, parameterized types, package functions, generate/assertion macros, and
an interface/modport definition. It also validates type-reference resolution,
parameter-override navigation, right-click definition lookup, and assertion-macro
include lookup. The tool does not claim complete interface-port semantic mapping;
the fixture validates compilation, snapshotting, and basic browsing.
