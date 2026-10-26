module top;
  import p::byte_t;
  import p::*;
  byte_t a;
  byte_t y;
  assign a = 8'h5a;
  leaf u_leaf(.a(a), .y(y));
endmodule
