module.exports = {
  NODE_RPC: 'http://127.0.0.1:8732/',
  MONGO_URL: 'mongodb://localhost:27017/dbname',
  START_INDEXING_LEVEL: 1085761, // Level a baker has started
  BAKER_LIST: [
    'address'
  ],
  PAYMENT_SCRIPT: {
    ENABLED_AUTOPAYMENT: true, // You need to make payments manually if this option is disabled.
    AUTOPAYMENT_LEVEL: 10, // 5 is a minimal level
    CYCLE_MAKE_AUTOPAYMENT: 5, // 0 is minimal
    BAKER_PRIVATE_KEYS: [
      'privatekey'
    ],
    MIN_PAYMENT_AMOUNT: 0.01, // Minimal reward to address in PLEX
    PAYMENT_FEE: 0.1, // fee mine
    DEFAULT_BAKER_COMMISSION: 0.07, // 1 = 100%, 0.1 = 10%
    BAKERS_COMMISSIONS: {},
    ADDRESSES_COMMISSIONS: {
      address1: 1,
      address2: 1
    },
    MAX_COUNT_OPERATIONS_IN_ONE_BLOCK: 199 // The maximum number of operations per block (1 - 199)
  }
}
