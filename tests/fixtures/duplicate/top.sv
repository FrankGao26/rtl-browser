module leaf (
  input  logic a,
  output logic y
);
  assign y = a;
endmodule

module top;
  logic a;
  logic y1;
  logic y2;
  assign a = 1'b1;

  leaf u1 (.a(a), .y(y1));
  leaf u2 (.a(a), .y(y2));
endmodule
