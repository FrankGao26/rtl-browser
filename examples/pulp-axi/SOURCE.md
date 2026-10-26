# Source provenance

## Upstream repositories

| Component | Upstream | Pinned revision | Version | License |
|---|---|---|---|---|
| AXI library | https://github.com/pulp-platform/axi | `70b8e54fd460e3308e58be596ceb3566a6e3576e` | 0.39.11 | SHL-0.51 |
| common_cells | https://github.com/pulp-platform/common_cells | `db42769334b4589b4b3fc671b34513bdb98be565` | dependency of AXI | SHL-0.51 |
| tech_cells_generic | https://github.com/pulp-platform/tech_cells_generic | `55cb54513e2d426be5992d311cb9d5dbcad10c78` | dependency of AXI | SHL-0.51 |

The AXI revision and dependency revisions are the ones declared by the AXI
`Bender.yml`/`Bender.lock` at the pinned commit.

## Copied files

The following files/directories are unmodified copies of upstream sources:

- `rtl/axi/` — the complete `src/` directory of the AXI repository;
- `tb/axi_synth_bench.sv` — the upstream synthesis benchmark;
- `include/axi/` — upstream `include/axi/` headers;
- `deps/common_cells/src/` — the complete upstream `src/` directory, including
  `src/deprecated/` legacy wrappers required by AXI's older module names;
- `deps/common_cells/include/` — upstream include headers;
- `deps/tech_cells_generic/src/rtl/` — the generic `tc_sync`, `tc_clk`, and
  `tc_sram` cells used by common_cells;
- `licenses/` — verbatim upstream license files.

`common_verification` is not copied; the selected RTL does not require its
simulation-only sources at compile/elaboration time.

## Authored files

- `rtl/example/pulp_axi_xbar_top.sv` — a fixed 4×4, 64-bit AXI4+ATOP wrapper
  around the unmodified `axi_xbar`. It defines concrete channel/request/response
  types in `pulp_axi_example_pkg` so the upstream parameterized module can be
  elaborated as a standalone top.
- `design.f` — the static file list, using paths relative to this example
  directory. It also adds the two include directories and compiles
  `axi_synth_bench.sv` as an optional full-library source.
- `README.md`, this file.

No upstream source file is modified. The wrapper is separate from the
upstream tree and does not change the semantics of `axi_xbar`.
