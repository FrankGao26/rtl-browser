module leaf_default #(parameter int W = 4) (
  input logic [W-1:0] a,
  output logic [W-1:0] y
);
  assign y = a;
endmodule
