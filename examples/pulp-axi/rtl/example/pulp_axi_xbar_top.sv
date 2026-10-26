// Example top-level wrapper for the upstream pulp-platform/axi library.
// A 4x4 AXI4+ATOP crossbar with 64-bit addresses/data and 4-bit IDs.
`include "axi/typedef.svh"

package pulp_axi_example_pkg;
  import axi_pkg::*;

  localparam xbar_cfg_t Cfg = '{
    NoSlvPorts:         32'd4,
    NoMstPorts:         32'd4,
    MaxMstTrans:        32'd5,
    MaxSlvTrans:        32'd5,
    FallThrough:        1'b1,
    LatencyMode:        CUT_ALL_PORTS,
    PipelineStages:     32'd0,
    AxiIdWidthSlvPorts: 32'd4,
    AxiIdUsedSlvPorts:  32'd4,
    UniqueIds:          1'b1,
    AxiAddrWidth:       32'd64,
    AxiDataWidth:       32'd64,
    NoAddrRules:        32'd4
  };

  typedef logic [Cfg.AxiIdWidthSlvPorts + $clog2(Cfg.NoSlvPorts)-1:0] mst_id_t;
  typedef logic [Cfg.AxiIdWidthSlvPorts-1:0]                          slv_id_t;
  typedef logic [Cfg.AxiAddrWidth-1:0]                                addr_t;
  typedef logic [Cfg.AxiDataWidth-1:0]                                data_t;
  typedef logic [Cfg.AxiDataWidth/8-1:0]                              strb_t;
  typedef logic                                                       user_t;

  `AXI_TYPEDEF_AW_CHAN_T(slv_aw_chan_t, addr_t, slv_id_t, user_t)
  `AXI_TYPEDEF_AW_CHAN_T(mst_aw_chan_t, addr_t, mst_id_t, user_t)
  `AXI_TYPEDEF_W_CHAN_T(w_chan_t, data_t, strb_t, user_t)
  `AXI_TYPEDEF_B_CHAN_T(slv_b_chan_t, slv_id_t, user_t)
  `AXI_TYPEDEF_B_CHAN_T(mst_b_chan_t, mst_id_t, user_t)
  `AXI_TYPEDEF_AR_CHAN_T(slv_ar_chan_t, addr_t, slv_id_t, user_t)
  `AXI_TYPEDEF_AR_CHAN_T(mst_ar_chan_t, addr_t, mst_id_t, user_t)
  `AXI_TYPEDEF_R_CHAN_T(slv_r_chan_t, data_t, slv_id_t, user_t)
  `AXI_TYPEDEF_R_CHAN_T(mst_r_chan_t, data_t, mst_id_t, user_t)
  `AXI_TYPEDEF_REQ_T(slv_req_t, slv_aw_chan_t, w_chan_t, slv_ar_chan_t)
  `AXI_TYPEDEF_REQ_T(mst_req_t, mst_aw_chan_t, w_chan_t, mst_ar_chan_t)
  `AXI_TYPEDEF_RESP_T(slv_resp_t, slv_b_chan_t, slv_r_chan_t)
  `AXI_TYPEDEF_RESP_T(mst_resp_t, mst_b_chan_t, mst_r_chan_t)
  typedef axi_pkg::xbar_rule_64_t rule_t;
endpackage

module pulp_axi_xbar_top (
  input  logic                                       clk_i,
  input  logic                                       rst_ni,
  input  pulp_axi_example_pkg::slv_req_t  [3:0]      slv_ports_req_i,
  output pulp_axi_example_pkg::slv_resp_t [3:0]      slv_ports_resp_o,
  output pulp_axi_example_pkg::mst_req_t  [3:0]      mst_ports_req_o,
  input  pulp_axi_example_pkg::mst_resp_t [3:0]      mst_ports_resp_i,
  input  pulp_axi_example_pkg::rule_t     [3:0]      addr_map_i,
  input  logic                            [3:0]      en_default_mst_port_i,
  input  logic                            [3:0][1:0]  default_mst_port_i
);

  axi_xbar #(
    .Cfg            ( pulp_axi_example_pkg::Cfg            ),
    .ATOPs          ( 1'b1                                 ),
    .Connectivity   ( '1                                   ),
    .slv_aw_chan_t  ( pulp_axi_example_pkg::slv_aw_chan_t  ),
    .mst_aw_chan_t  ( pulp_axi_example_pkg::mst_aw_chan_t  ),
    .w_chan_t       ( pulp_axi_example_pkg::w_chan_t       ),
    .slv_b_chan_t   ( pulp_axi_example_pkg::slv_b_chan_t   ),
    .mst_b_chan_t   ( pulp_axi_example_pkg::mst_b_chan_t   ),
    .slv_ar_chan_t  ( pulp_axi_example_pkg::slv_ar_chan_t  ),
    .mst_ar_chan_t  ( pulp_axi_example_pkg::mst_ar_chan_t  ),
    .slv_r_chan_t   ( pulp_axi_example_pkg::slv_r_chan_t   ),
    .mst_r_chan_t   ( pulp_axi_example_pkg::mst_r_chan_t   ),
    .slv_req_t      ( pulp_axi_example_pkg::slv_req_t      ),
    .slv_resp_t     ( pulp_axi_example_pkg::slv_resp_t     ),
    .mst_req_t      ( pulp_axi_example_pkg::mst_req_t      ),
    .mst_resp_t     ( pulp_axi_example_pkg::mst_resp_t     ),
    .rule_t         ( pulp_axi_example_pkg::rule_t         )
  ) i_xbar (
    .clk_i,
    .rst_ni,
    .slv_ports_req_i,
    .slv_ports_resp_o,
    .mst_ports_req_o,
    .mst_ports_resp_i,
    .addr_map_i,
    .en_default_mst_port_i,
    .default_mst_port_i
  );

endmodule
