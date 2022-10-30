const Reward = require('../models/reward')()
const RewardNew = require('../models/rewardNew')()
const config = require('../config')
const mongoose = require('mongoose')

const { mpapi } = require('mineplex-rpcapi')
mpapi.node.setProvider(config.NODE_RPC)
mpapi.node.setDebugMode(false)

mongoose.connect(config.MONGO_URL,
  {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    useFindAndModify: false
  }, async (error) => {
    if (error) throw error

    let { level } = await Reward.findOne({
      paymentOperationHash: null
    })

    while (true) {
      const block = await mpapi.rpc.getHead(level)
      const cycle = block.metadata.level.cycle
      const firstCycLelevel = cycle * 1440 + 1
      const lastCycleLevel = (cycle * 1440) + 1440
      const rewards = {}
      const rewardsByAddress = await Reward.find({
        from: 'mp1SMSWgg1pdqp8AUm3XyCxncu7hP3d3wvAN',
        level: {
          $gte: firstCycLelevel,
          $lte: lastCycleLevel
        },
        paymentOperationHash: null
      }).lean()

      if (rewardsByAddress.length === 0) break

      rewardsByAddress.forEach(({ from, to, amount }) => {
        if (rewards[to]) {
          rewards[to].amount = rewards[to].amount + amount
        } else {
          rewards[to] = {
            from,
            to,
            cycle,
            amount
          }
        }
      })

      await RewardNew.insertMany(Object.values(rewards))
      console.log(rewardsByAddress.length)
      level = lastCycleLevel + 1
    }

    await mongoose.disconnect()
  })
