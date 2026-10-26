`ifndef DEFS_SVH
`define DEFS_SVH
`define PICK_VALUE(v) \
`ifdef INNER_MACRO_FLAG \
  v \
`else \
  1'b0 \
`endif
`endif
