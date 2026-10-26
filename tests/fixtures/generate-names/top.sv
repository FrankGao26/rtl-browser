module top;
  logic a;
  assign a = 1'b1;

  // Unnamed if-generate: slang assigns a genblk name.
  if (1) begin
    logic b;
    assign b = a;
  end

  // Unnamed for-generate: entries should be shown as name[i] one level deep.
  for (genvar i = 0; i < 2; i++) begin
    logic c;
    assign c = a;
  end
endmodule
