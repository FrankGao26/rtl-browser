`include "defs.svh"
module leaf (
  input p::byte_t a,
  output p::byte_t y
);
  import p::*;
  logic [`WIDTH-1:0] tmp;
  assign tmp = a;
  assign y = tmp;
endmodule
