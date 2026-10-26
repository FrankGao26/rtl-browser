module top;
  logic always_active;
`ifdef ENABLE_A
  logic a;
  `ifndef DISABLE_B
    logic b;
    `ifdef INNER_UNUSED
      logic e;
    `else
      logic f;
    `endif
  `else
    logic c;
    `ifdef OUTER_ELSE_INNER
      logic h;
    `endif
  `endif
`elsif ENABLE_C
  logic g;
`else
  logic d;
  `ifdef INNER_UNUSED
    logic i;
  `endif
`endif
  logic last;
endmodule
