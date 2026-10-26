package types_pkg;
  typedef logic [3:0] nibble_t;

  typedef struct packed {
    nibble_t nibble;
    logic    valid;
  } element_t;

  typedef struct packed {
    element_t elem;
    logic     last;
  } pair_t;
endpackage
