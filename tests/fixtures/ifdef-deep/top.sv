module top;
  logic always_active;
`ifdef L1
  logic t1;
  `ifndef L2
    logic t2;
    `ifdef L3
      logic t3;
      `ifndef L4
        logic t4;
        `ifdef L5
          logic t5;
          `ifndef L6
            logic t6;
            `ifdef L7
              logic t7;
              `ifndef L8
                logic t8;
                `ifdef L9
                  logic t9;
                  `ifndef L10
                    logic t10;
                    `ifdef L11
                      logic t11;
                      `ifndef L12
                        logic t12;
                        `ifdef L13
                          logic t13;
                          `ifndef L14
                            logic t14;
                            `ifdef L15
                              logic t15;
                              `ifndef L16
                                logic t16;
                              `else
                                logic e16;
                              `endif
                            `else
                              logic e15;
                            `endif
                          `else
                            logic e14;
                          `endif
                        `else
                          logic e13;
                        `endif
                      `else
                        logic e12;
                      `endif
                    `else
                      logic e11;
                    `endif
                  `else
                    logic e10;
                  `endif
                `else
                  logic e9;
                `endif
              `else
                logic e8;
              `endif
            `else
              logic e7;
            `endif
          `else
            logic e6;
          `endif
        `else
          logic e5;
        `endif
      `else
        logic e4;
      `endif
    `else
      logic e3;
    `endif
  `else
    logic e2;
  `endif
`else
  logic e1;
`endif
  logic last;
endmodule
