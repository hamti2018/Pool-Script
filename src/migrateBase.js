const RewardOld = require('../models/rewardOld')()
const Reward = require('../models/reward')()
const config = require('../config')
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(config.MONGO_URL, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    useFindAndModify: false
  })

  let { level } = await RewardOld.findOne({
    paymentOperationHash: null
  })
  console.log('first level', level)

  let count = await RewardOld.find({
    paymentOperationHash: null
  }).count()

  while (true) {
    const cycle = Math.floor(level / 1440)
    const firstCycLelevel = cycle * 1440 + 1
    const lastCycleLevel = (cycle * 1440) + 1440

    console.log('current cycle ' + cycle, firstCycLelevel, lastCycleLevel)

    const rewards = {}
    const rewardsByAddress = await RewardOld.find({
      level: {
        $gte: firstCycLelevel,
        $lte: lastCycleLevel
      },
      paymentOperationHash: null
    }).lean()

    count = count - rewardsByAddress.length

    if (rewardsByAddress.length === 0 && count === 0) break
    if (rewardsByAddress.length === 0) {
      level = lastCycleLevel + 1
      continue
    }

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

    await Reward.insertMany(Object.values(rewards))
    console.log(rewardsByAddress.length)
    level = lastCycleLevel + 1
  }

  await mongoose.disconnect()
})()
