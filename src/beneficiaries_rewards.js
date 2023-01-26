const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')

const { mpapi } = require('mineplex-rpcapi')

const rewards = {
  mp1SMSWgg1pdqp8AUm3XyCxncu7hP3d3wvAN: [
    { to: 'mp1P7sPz1NurnnVm91VCseQrgwEmeqHDNiyi', amount: 0.1 },
    { to: 'mp1QQo5EnFAC2zz28QxTWUfKhtJPoAq5Varw', amount: 0.9 },
  ],
  mp1PyHahrrfxtP4ipV8Sohe5rp1aSgfQwoVD: [
    { to: 'mp1P7sPz1NurnnVm91VCseQrgwEmeqHDNiyi', amount: 0.15 },
    { to: 'mp1QQo5EnFAC2zz28QxTWUfKhtJPoAq5Varw', amount: 0.15 },
    { to: 'mp1Dkmh691LhaYE9UJFVWNJPETQdQQtMm9dN', amount: 0.7 },
  ],
  mp15ckiHhnAAcuTNtTGynpB9H8wci6Zg4Pue: [
    { to: 'mp1P7sPz1NurnnVm91VCseQrgwEmeqHDNiyi', amount: 0.1 },
    { to: 'mp1QQo5EnFAC2zz28QxTWUfKhtJPoAq5Varw', amount: 0.1 },
    { to: 'mp1Dkmh691LhaYE9UJFVWNJPETQdQQtMm9dN', amount: 0.1 },
    { to: 'mp1DHU1THiYEjPkcYjMKPRrfNsViCAP1soS9', amount: 0.7 },
  ],
  mp1HiXnuD6CBsYbVDQ3cGeP7nruwdvsahVbj: [
    { to: 'mp1P7sPz1NurnnVm91VCseQrgwEmeqHDNiyi', amount: 0.15 },
    { to: 'mp1QQo5EnFAC2zz28QxTWUfKhtJPoAq5Varw', amount: 0.15 },
    { to: 'mp1KkgxUU2xWEFAbBc5Wb1LRgttd3jYwhRAn', amount: 0.7 },
  ],
}

const config = yaml.load(
  fs.readFileSync(path.join(__dirname, '..', 'config.yaml'), 'utf8')
)

const {
  NODE_RPC,
  BENEFICIARIES_REWARDS,
  BAKER_LIST,
  BAKER_PRIVATE_KEYS,
  PAYMENT_FROM_ANOTHER_WALLET,
  PAYMENT_FROM_ANOTHER_WALLET_PRIVATE_KEYS,
} = config

mpapi.node.setProvider(NODE_RPC)
mpapi.node.setDebugMode(false)

const rewardsBeneficiaries = async function () {
  if (require.main || !BENEFICIARIES_REWARDS) return

  const bakerList = PAYMENT_FROM_ANOTHER_WALLET
    ? Object.entries(PAYMENT_FROM_ANOTHER_WALLET_PRIVATE_KEYS)
    : Object.entries(BAKER_PRIVATE_KEYS)

  for (const [baker, sk] of bakerList) {
    try {
      const bakerKeys = mpapi.crypto.extractKeys(sk)
      const reward = rewards[baker]
      const plexBalance = mpapi.utility.totez(
        await mpapi.rpc.getPlexBalance(bakerKeys.pkh)
      )

      if (!reward) continue

      const operations = reward.map(({ to, amount }) => {
        return {
          to,
          amount: Math.floor(plexBalance * amount),
        }
      })

      const fee = 1
      const gasLimit = 0.010307
      const storageLimit = 0.000257

      const { hash } = await mpapi.rpc.sendOperation(
        bakerKeys.pkh,
        operations.map((operation) => ({
          kind: 'transaction',
          fee: mpapi.utility.mutez(fee).toString(),
          gas_limit: mpapi.utility.mutez(gasLimit).toString(),
          storage_limit: mpapi.utility.mutez(storageLimit).toString(),
          amount: mpapi.utility.mutez(operation.amount).toString(),
          destination: operation.to,
        })),
        bakerKeys
      )

      console.log(new Date(), 'beneficiaries reward hash ', hash)
    } catch (e) {
      console.log(new Date(), 'beneficiaries reward error ', e)
    }

    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}

if (require.main) {
  BENEFICIARIES_REWARDS = true
  rewardsBeneficiaries()
}

module.exports = rewardsBeneficiaries
