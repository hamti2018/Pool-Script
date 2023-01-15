const fs = require('fs')
const path = require('path')
const mongoose = require('mongoose')

const yaml = require('js-yaml')

const config = yaml.load(
  fs.readFileSync(path.join(__dirname, '..', 'config.yaml'), 'utf8')
)
const { Schema } = mongoose

const Reward = new Schema(
  {
    from: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    to: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    level: {
      type: Number,
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    type: {
      type: String,
      required: true,
      index: true,
      enum: Object.values(config.REWARD_TYPES),
    },
    paymentOperationHash: {
      type: String,
      trim: true,
      index: true,
    },
  },
  {
    timestamps: true,
    autoIndex: true,
  }
)

module.exports = () => {
  return mongoose.model('Rewardold', Reward)
}
