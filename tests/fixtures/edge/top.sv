module top #(parameter int W_TOP = 8);
  logic [3:0] a4;
  logic [3:0] y4;
  logic [7:0] a8;
  logic [7:0] y8;

  assign a4 = 4'h3;
  leaf_default u_default (.a(a4), .y(y4));
  leaf #(.W(W_TOP)) u8 (.a(a8), .y(y8));
  leaf #(.W(4)) u_const (.a(1'b0), .y());

  for (genvar i = 0; i < 2; i++) begin : g
    leaf #(.W(4)) u_g (.a(a4), .y());
  end
endmodule
