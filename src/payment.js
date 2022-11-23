const lodash = require('lodash')
const async = require('async')
const { mpapi } = require('mineplex-rpcapi')

const Reward = require('../models/rewardNew')()
const config = require('../config')

mpapi.node.setProvider(config.NODE_RPC)
mpapi.node.setDebugMode(false)

const runPaymentScript = async ({ bakerKeys, cycle }) => {
  console.log(`Start payment from ${bakerKeys.pkh}`)
  const Operation = require('../models/operation')(bakerKeys.pkh)

  // if (config.PAYMENT_SCRIPT.CYCLE_MAKE_AUTOPAYMENT > 0) {
  //   lastLevel = lastLevel - (1440 * config.PAYMENT_SCRIPT.CYCLE_MAKE_AUTOPAYMENT)
  // }

  // console.log('Rewarding period is up to ', lastLevel)
  // if (!lastLevel) {
  //   console.log('Cant load last block')
  //   return
  // }
  cycle = cycle - config.PAYMENT_SCRIPT.CYCLE_MAKE_AUTOPAYMENT

  const rewardsByAddress = await Reward.aggregate([{
    $match: {
      from: bakerKeys.pkh,
      cycle: { $lte: cycle },
      paymentOperationHash: null
    }
  }, {
    $group: {
      _id: '$to',
      amountPlexGross: { $sum: '$amount' }
    }
  }])

  console.log('Loaded addresses', rewardsByAddress.length)

  const operations = []

  const bakerCommission = lodash.isNumber(config.PAYMENT_SCRIPT.BAKERS_COMMISSIONS[bakerKeys.pkh])
    ? config.PAYMENT_SCRIPT.BAKERS_COMMISSIONS[bakerKeys.pkh]
    : config.PAYMENT_SCRIPT.DEFAULT_BAKER_COMMISSION

  await lodash.each(rewardsByAddress, async ({ amountPlexGross, _id }) => {
    const commission = lodash.isNumber(config.PAYMENT_SCRIPT.ADDRESSES_COMMISSIONS[_id])
      ? config.PAYMENT_SCRIPT.ADDRESSES_COMMISSIONS[_id]
      : bakerCommission

    const amountPlex = amountPlexGross * (1 - commission)
    if (amountPlex >= config.PAYMENT_SCRIPT.MIN_PAYMENT_AMOUNT) {
      const fee = config.PAYMENT_SCRIPT.PAYMENT_FEE
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

  console.log('Count operations', operations.length)
  console.log('Total plex rewards:', operations.reduce((acc, operation) => acc + operation.amountPlex, 0))

  if (!operations.length) {
    console.log('No operations found', new Date())
    return
  }

  const currentDate = new Date()
  const oneChunk = async (operations) => {
    try {
      const sendOperations = async (operations) => {
        try {
          console.log('Try to send operations')
          const { hash = `${bakerKeys.pkh}-${currentDate}` } = await mpapi.rpc.sendOperation(bakerKeys.pkh, operations.map(operation => ({
            kind: 'transaction',
            fee: mpapi.utility.mutez(operation.fee).toString(),
            gas_limit: mpapi.utility.mutez(operation.gasLimit).toString(),
            storage_limit: mpapi.utility.mutez(operation.storageLimit).toString(),
            amount: mpapi.utility.mutez(operation.amountPlex).toString(),
            destination: operation.to
          })), bakerKeys)

          return hash
        } catch (error) {
          console.log('RPC Error:', error)
          return await sendOperations(operations)
        }
      }
      const hash = await sendOperations(operations)
      console.log('Operation hash', hash)

      console.log('Updated rewards with hash', await Reward.updateMany({
        from: bakerKeys.pkh,
        to: operations.map(operation => operation.to),
        cycle: cycle
      }, {
        $set: {
          paymentOperationHash: hash
        }
      }))

      await Operation.insertMany(operations.map(operation => ({
        to: operation.to,
        from: bakerKeys.pkh,
        amountPlex: operation.amountPlex,
        amountPlexGross: operation.amountPlexGross,
        operationHash: hash,
        fee: operation.fee
      })))

      const blockHash = await mpapi.rpc.awaitOperation(hash, 10 * 1000, 61 * 60 * 1000)
      console.log('Block hash:', blockHash)
    } catch (error) {
      console.log('Error', error)
    }
  }

  const chunkedOperations = lodash.chunk(operations, lodash.min([config.PAYMENT_SCRIPT.MAX_COUNT_OPERATIONS_IN_ONE_BLOCK, 199]))
  await async.eachLimit(chunkedOperations, 1, async (operations) => {
    await oneChunk(operations)
  })
}

module.exports = {
  runPaymentScript
}
