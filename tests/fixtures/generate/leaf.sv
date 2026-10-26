module leaf #(parameter int W = 4) (
  input logic [W-1:0] a,
  output logic [W-1:0] y
);
  logic [W-1:0] tmp;
  assign tmp = a;
  assign y = tmp;
endmodule
