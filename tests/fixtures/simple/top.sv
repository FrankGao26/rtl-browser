module top #(parameter int W_TOP = 8);
  logic [7:0] a8;
  logic [7:0] y8;
  logic [7:0] mirror8;
  logic [15:0] a16;
  logic [15:0] y16;

  assign a8 = 8'h12;
  assign mirror8 = a8;
  assign a16 = 16'h1234;

  leaf #(.W(W_TOP)) u8 (.a(a8), .y(y8));
  leaf #(.W(16)) u16 (.a(a16), .y(y16));
endmodule
