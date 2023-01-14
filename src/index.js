const fs = require('fs')
const path = require('path')

const yaml = require('js-yaml')
const mongoose = require('mongoose')
const lodash = require('lodash')
const cache = require('memory-cache')
const async = require('async')
const { mpapi } = require('mineplex-rpcapi')

const payment = require('./payment')

const Settings = require('../models/settings')()
const BakerCycle = require('../models/bakerCycle')()
const Reward = require('../models/reward')()

const PRESERVES_CYCLE = 5 + 2
const BLOCKS_IN_CYCLE = 1440
const TIME_BETWEEN_BLOCKS = 60
const STEP_PROCESS_CYCLE = 500

const blocksCache = new cache.Cache()
const blockConstantsCache = new cache.Cache()
const cycleInfoCache = new cache.Cache()

const config = yaml.load(
  fs.readFileSync(path.join(__dirname, '..', 'config.yaml'), 'utf8')
)
const {
  NODE_RPC,
  MONGO_URL,
  START_INDEXING_LEVEL,
  BAKER_LIST,
  ENABLED_AUTOPAYMENT,
  AUTOPAYMENT_LEVEL,
  BAKER_PRIVATE_KEYS,
  PAYMENT_FROM_ANOTHER_WALLET,
  PAYMENT_FROM_ANOTHER_WALLET_PRIVATE_KEYS,
  REWARD_TYPES,
} = config

mpapi.node.setProvider(NODE_RPC)
mpapi.node.setDebugMode(false)

const isInBakerList = (baker) => BAKER_LIST.indexOf(baker) >= 0

module.exports = async function () {
  await mongoose.connect(MONGO_URL, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    useFindAndModify: false,
  })

  const startIndex = async () => {
    const { lastIndexedLevel } = (await Settings.findOne()) || {}
    const head = await getBlock()

    let level = lodash.max([
      (lastIndexedLevel || 0) + 1,
      START_INDEXING_LEVEL,
      BLOCKS_IN_CYCLE * PRESERVES_CYCLE,
    ])

    console.log(new Date(), ' Starting from', level)

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (level >= head.header.level) {
        break
      }

      try {
        const block = await getBlock(level)
        const nextBlock = await getBlock(level + 1)
        const cycleInfo = await getCycleInfo(block.metadata.level.cycle)
        console.log(
          new Date(),
          ` Current level is ${level}, block hash is ${block.hash}`
        )
        const startTime = new Date().getTime()
        await handleBlock(block, nextBlock)
        const endTime = new Date().getTime()
        console.log(
          new Date(),
          ` End of block handling. Run time: ${endTime - startTime}`
        )
        await Settings.findOneAndUpdate(
          {},
          {
            $set: {
              lastIndexedLevel: level,
            },
          },
          {
            upsert: true,
          }
        )

        if (
          !ENABLED_AUTOPAYMENT ||
          level !== cycleInfo.first + lodash.max([5, AUTOPAYMENT_LEVEL])
        ) {
          level += 1
          continue
        }

        const bakerList = PAYMENT_FROM_ANOTHER_WALLET
          ? Object.entries(PAYMENT_FROM_ANOTHER_WALLET_PRIVATE_KEYS)
          : Object.entries(BAKER_PRIVATE_KEYS)

        await async.eachLimit(bakerList, 1, async (baker) => {
          const [pkh, privateKey] = baker
          const bakerKeys = mpapi.crypto.extractKeys(privateKey)
          await payment.runPaymentScript({
            pkh,
            bakerKeys,
            cycle: block.metadata.level.cycle - 1,
          })
        })
      } catch (error) {
        console.log(new Date(), ' Error on', level, error)
        break
      }
      level += 1
    }

    console.log(new Date(), ' Level is greater than the head, waiting...')
    setTimeout(() => {
      console.log(new Date(), ' Continue indexing')
      startIndex()
    }, 1000 * 60)
  }

  await startIndex()
}

const getBlock = async (level = 'head') => {
  const cachedBlock = blocksCache.get(level)

  if (!cachedBlock) {
    const block = await mpapi.rpc.getHead(level)
    blocksCache.put(
      block.header.level,
      block,
      BLOCKS_IN_CYCLE * PRESERVES_CYCLE * TIME_BETWEEN_BLOCKS
    )
    return block
  }

  return cachedBlock
}

async function getBlockConstants(level) {
  if (!lodash.isNumber(level)) {
    throw new Error('Level must be a number')
  }

  const cachedBlockConstants = blockConstantsCache.get(level)

  if (!cachedBlockConstants) {
    const blockConstants = await mpapi.rpc.getConstants(level)
    blockConstantsCache.put(
      level,
      blockConstants,
      BLOCKS_IN_CYCLE * PRESERVES_CYCLE * TIME_BETWEEN_BLOCKS
    )

    return blockConstants
  }
  return cachedBlockConstants
}

async function getCycleInfo(cycle) {
  if (!lodash.isNumber(cycle)) {
    throw new Error('Cycle must be a number')
  }

  const cachedCycleInfo = cycleInfoCache.get(cycle)

  if (!cachedCycleInfo) {
    const cycleInfo = await mpapi.rpc.getLevelsInCurrentCycle(
      BLOCKS_IN_CYCLE * cycle + 1
    )
    cycleInfoCache.put(
      cycle,
      cycleInfo,
      BLOCKS_IN_CYCLE * PRESERVES_CYCLE * TIME_BETWEEN_BLOCKS
    )

    return cycleInfo
  }

  return cachedCycleInfo
}

function getBlockEndorsers(operations) {
  const findEndorsers = (operations) => {
    return operations.filter((operation) => {
      if (Array.isArray(operation)) {
        return findEndorsers(operation).length > 0
      } else {
        if (operation.contents) {
          return findEndorsers(operation.contents).length > 0
        } else {
          return operation.kind === 'endorsement'
        }
      }
    })
  }

  const endorserOperations = lodash.flattenDeep(findEndorsers(operations))
  return endorserOperations.map((operation) => ({
    address: operation.contents[0].metadata.delegate,
    slots: operation.contents[0].metadata.slots.length,
    level: operation.contents[0].level,
  }))
}

async function getDelegatedAddresses(baker, level) {
  const delegatedAddresses = await mpapi.rpc.getDelegatedAddresses(baker, level)
  return async.mapLimit(
    delegatedAddresses.filter((address) => address !== baker),
    2,
    async (address) => ({
      address,
      balance: mpapi.utility.totez(
        await mpapi.rpc.getMineBalance(address, level)
      ),
    })
  )
}

async function getBakerCycle(baker, cycle) {
  const bakerCycle = await BakerCycle.findOne({
    address: baker,
    cycle: cycle,
  })

  if (bakerCycle) {
    return bakerCycle
  }

  const cycleInfo = await getCycleInfo(cycle)

  let minDelegatorsBalances = []
  let minFullStakingBalance = 0
  let minOwnBalance = 0
  let minDelegatedBalance = 0

  for (
    let level = cycleInfo.first;
    level <= cycleInfo.last;
    level += STEP_PROCESS_CYCLE
  ) {
    console.log(new Date(), ` Start checking for ${baker} in ${level}`)

    const gettingData = async (attemp) => {
      try {
        const levelDelegatorsBalances = await getDelegatedAddresses(
          baker,
          level
        )
        const fullStakingBalance = mpapi.utility.totez(
          await mpapi.rpc.getStakingMineBalance(baker, level)
        )
        const ownBalance = mpapi.utility.totez(
          await mpapi.rpc.getOwnStakingMineBalance(baker, level)
        )
        const delegatedBalance = mpapi.utility.totez(
          await mpapi.rpc.getDelegatedBalance(baker, level)
        )

        return {
          levelDelegatorsBalances,
          fullStakingBalance,
          ownBalance,
          delegatedBalance,
        }
      } catch (error) {
        console.log(
          new Date(),
          ` There is an error ${error} at getting data, attemp ${attemp}`
        )
        console.log(new Date(), ' Repeat for getting data')
        return await gettingData(++attemp)
      }
    }

    const {
      levelDelegatorsBalances,
      fullStakingBalance,
      ownBalance,
      delegatedBalance,
    } = await gettingData(0)

    if (level === cycleInfo.first) {
      minDelegatorsBalances = levelDelegatorsBalances
      minFullStakingBalance = fullStakingBalance
      minOwnBalance = ownBalance
      minDelegatedBalance = delegatedBalance
    }

    minFullStakingBalance = lodash.min([
      minFullStakingBalance,
      fullStakingBalance,
    ])
    minOwnBalance = lodash.min([minOwnBalance, ownBalance])
    minDelegatedBalance = lodash.min([minDelegatedBalance, delegatedBalance])

    const stableLevelDelegators = lodash.intersectionBy(
      levelDelegatorsBalances,
      minDelegatorsBalances,
      'address'
    )
    if (!stableLevelDelegators.length) {
      minDelegatorsBalances = []
      break
    }

    if (stableLevelDelegators.length !== minDelegatorsBalances.length) {
      minDelegatorsBalances = lodash.intersectionBy(
        minDelegatorsBalances,
        stableLevelDelegators,
        'address'
      )
    }

    minDelegatorsBalances = lodash.zipWith(
      stableLevelDelegators,
      minDelegatorsBalances,
      (levelDelegator, cycleDelegator) => {
        return {
          address: levelDelegator.address,
          balance: lodash.min([cycleDelegator.balance, levelDelegator.balance]),
        }
      }
    )
  }

  return BakerCycle.findOneAndUpdate(
    {
      address: baker,
      cycle: cycle,
    },
    {
      $set: {
        baker,
        cycle,
        minFullStakingBalance,
        minOwnBalance,
        minDelegatedBalance,
        fullCycleDelegators: minDelegatorsBalances.map((delegator) => ({
          address: delegator.address,
          minDelegatedBalance: delegator.balance,
        })),
      },
    },
    {
      upsert: true,
      new: true,
    }
  )
}

async function getRewards(
  block,
  type = REWARD_TYPES.FOR_BAKING,
  baker,
  { endorsers = [], slots = 0 }
) {
  const level = block.metadata.level.level
  const cycle = block.metadata.level.cycle
  const priority = block.header.priority
  // eslint-disable-next-line camelcase
  const { baking_reward_per_endorsement, endorsement_reward } =
    await getBlockConstants(level)

  const bakerCycle = await getBakerCycle(baker, cycle - PRESERVES_CYCLE)
  if (!bakerCycle) {
    return []
  }

  let totalReward = 0
  switch (type) {
    case REWARD_TYPES.FOR_BAKING:
      // eslint-disable-next-line no-case-declarations
      const countEndorsers = endorsers.reduce(
        (count, endorser) => count + endorser.slots,
        0
      )
      if (priority === 0) {
        totalReward = baking_reward_per_endorsement[0] * countEndorsers
      } else {
        totalReward = baking_reward_per_endorsement[1] * countEndorsers
      }
      break
    case REWARD_TYPES.FOR_ENDORSING:
      if (priority === 0) {
        totalReward = endorsement_reward[0] * slots
      } else {
        totalReward = endorsement_reward[1] * slots
      }
      break
  }
  totalReward = mpapi.utility.totez(totalReward)

  let rewardOfAddresses = []
  if (bakerCycle.fullCycleDelegators.length) {
    rewardOfAddresses = bakerCycle.fullCycleDelegators.map((delegator) => ({
      address: delegator.address,
      reward: lodash.floor(
        (totalReward / bakerCycle.minFullStakingBalance) *
          delegator.minDelegatedBalance,
        7
      ),
      metadata: {
        priority,
        cycle,
        totalReward,
        countEndorsers: endorsers.length,
        countSlots: slots,
        bakingRewardConstant: baking_reward_per_endorsement,
        endorsementRewardConstant: endorsement_reward,
        minDelegatedBalance: delegator.minDelegatedBalance,
      },
    }))
  }

  console.log('cycle', cycle)

  rewardOfAddresses = rewardOfAddresses.filter(
    (delegator) => delegator.metadata.minDelegatedBalance > 100
  )
  return rewardOfAddresses
}

async function getRewardsForBaker(block, bakerAddress, endorsers) {
  return await getRewards(block, REWARD_TYPES.FOR_BAKING, bakerAddress, {
    endorsers,
  })
}

async function getRewardsForEndorser(block, endorserAddress, slots) {
  return await getRewards(block, REWARD_TYPES.FOR_ENDORSING, endorserAddress, {
    slots,
  })
}

async function saveRewards(bakerAddress, rewards) {
  await async.mapLimit(rewards, 10, async (reward) => {
    return Reward.updateOne(
      {
        from: bakerAddress,
        to: reward.address,
        cycle: reward.metadata.cycle,
      },
      {
        $set: {
          from: bakerAddress,
          to: reward.address,
          cycle: reward.metadata.cycle,
        },
        $inc: {
          amount: reward.reward,
        },
      },
      {
        upsert: true,
      }
    )
  })
}

async function handleBlock(block, nextBlock) {
  const baker = block.metadata.baker
  const blockEndorsers = getBlockEndorsers(nextBlock.operations)

  if (isInBakerList(baker)) {
    const rewards = await getRewardsForBaker(block, baker, blockEndorsers)
    console.log(
      new Date(),
      ` Found ${rewards.length} rewards for baking ${baker}`
    )
    await saveRewards(baker, rewards)
  }

  await async.eachLimit(blockEndorsers, 1, async (endorser) => {
    if (isInBakerList(endorser.address)) {
      const rewards = await getRewardsForEndorser(
        block,
        endorser.address,
        endorser.slots
      )
      console.log(
        new Date(),
        ` Found ${rewards.length} rewards for endorsing ${endorser.address}`
      )
      await saveRewards(endorser.address, rewards)
    }
  })
}
