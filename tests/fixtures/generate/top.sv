module top;
  logic [3:0] a4; // shared input
  logic [3:0] y4;
  logic [3:0] generated_sig; // generated assignment target

  assign a4 = 4'h3;

  if (0) begin : inactive_branch
    leaf u_inactive (.a(a4), .y());
  end else begin : active_branch
    leaf u_active (.a(a4), .y(y4));
  end

  for (genvar i = 0; i < 3; i++) begin : g
    logic [3:0] local_sig; // generated local
    assign local_sig = a4;
    leaf u_g (.a(a4), .y());
  end

  assign generated_sig = a4;
endmodule
