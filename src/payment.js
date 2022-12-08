const fs = require('fs')
const path = require('path')

const yaml = require('js-yaml')
const lodash = require('lodash')
const async = require('async')
const { mpapi } = require('mineplex-rpcapi')

const Reward = require('../models/reward')()

const config = yaml.load(fs.readFileSync(path.join(__dirname, '..', 'config.yaml'), 'utf8'))
const {
  NODE_RPC,
  CYCLE_MAKE_AUTOPAYMENT,
  BAKERS_COMMISSIONS,
  DEFAULT_BAKER_COMMISSION,
  ADDRESSES_COMMISSIONS,
  MIN_PAYMENT_AMOUNT,
  PAYMENT_FEE,

  MAX_COUNT_OPERATIONS_IN_ONE_BLOCK
} = config

mpapi.node.setProvider(NODE_RPC)
mpapi.node.setDebugMode(false)

const runPaymentScript = async ({ pkh, bakerKeys, cycle }) => {
  console.log(new Date(), ` Start payment from ${pkh}`)
  const Operation = require('../models/operation')(pkh)

  cycle = cycle - CYCLE_MAKE_AUTOPAYMENT

  const rewardsByAddress = await Reward.aggregate([{
    $match: {
      from: pkh,
      cycle: { $lte: cycle },
      paymentOperationHash: null
    }
  }, {
    $group: {
      _id: '$to',
      amountPlexGross: { $sum: '$amount' }
    }
  }])

  console.log(new Date(), ' Loaded addresses', rewardsByAddress.length)

  const operations = []

  const bakerCommission = lodash.isNumber(BAKERS_COMMISSIONS[pkh])
    ? BAKERS_COMMISSIONS[pkh]
    : DEFAULT_BAKER_COMMISSION

  await lodash.each(rewardsByAddress, async ({ amountPlexGross, _id }) => {
    const commission = lodash.isNumber(ADDRESSES_COMMISSIONS[_id])
      ? ADDRESSES_COMMISSIONS[_id]
      : bakerCommission

    const amountPlex = amountPlexGross * (1 - commission)
    if (amountPlex >= MIN_PAYMENT_AMOUNT) {
      const fee = PAYMENT_FEE
      const gasLimit = 0.010307
      const storageLimit = 0.000257
      operations.push({
        to: _id,
        fee,
        gasLimit,
        storageLimit,
        amountPlex,
        amountPlexGross
      })
    }
  })

  console.log(new Date(), ' Count operations', operations.length)
  console.log(new Date(), ' Total plex rewards:', operations.reduce((acc, operation) => acc + operation.amountPlex, 0))

  if (!operations.length) {
    console.log(new Date(), ' No operations found', new Date())
    return
  }

  const currentDate = new Date()
  const oneChunk = async (operations) => {
    try {
      const sendOperations = async (operations) => {
        try {
          console.log(new Date(), ' Try to send operations')
          const { hash = `${pkh}-${currentDate}` } = await mpapi.rpc.sendOperation(bakerKeys.pkh, operations.map(operation => ({
            kind: 'transaction',
            fee: mpapi.utility.mutez(operation.fee).toString(),
            gas_limit: mpapi.utility.mutez(operation.gasLimit).toString(),
            storage_limit: mpapi.utility.mutez(operation.storageLimit).toString(),
            amount: mpapi.utility.mutez(operation.amountPlex).toString(),
            destination: operation.to
          })), bakerKeys)

          return hash
        } catch (error) {
          console.log(new Date(), ' RPC Error:', error)
          return await sendOperations(operations)
        }
      }
      const hash = await sendOperations(operations)
      console.log(new Date(), ' Operation hash', hash)

      console.log(new Date(), ' Updated rewards with hash', await Reward.updateMany({
        from: pkh,
        to: operations.map(operation => operation.to),
        cycle: { $lte: cycle },
        paymentOperationHash: null
      }, {
        $set: {
          paymentOperationHash: hash
        }
      }))

      await Operation.insertMany(operations.map(operation => ({
        to: operation.to,
        from: pkh,
        amountPlex: operation.amountPlex,
        amountPlexGross: operation.amountPlexGross,
        operationHash: hash,
        fee: operation.fee
      })))

      const blockHash = await mpapi.rpc.awaitOperation(hash, 10 * 1000, 61 * 60 * 1000)
      console.log(new Date(), ' Block hash:', blockHash)
    } catch (error) {
      console.log(new Date(), ' Error', error)
    }
  }

  const chunkedOperations = lodash.chunk(operations, lodash.min([MAX_COUNT_OPERATIONS_IN_ONE_BLOCK, 199]))
  await async.eachLimit(chunkedOperations, 1, async (operations) => {
    await oneChunk(operations)
  })
}

module.exports = {
  runPaymentScript
}
