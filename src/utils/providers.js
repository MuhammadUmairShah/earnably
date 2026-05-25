const crypto = require('crypto');

const providers = {
  cpx: {
    name: 'CPX Research',
    secret: process.env.CPX_SECRET || 'cpx_demo_secret',
  },
  adgem: {
    name: 'AdGem',
    secret: process.env.ADGEM_SECRET || 'adgem_demo_secret',
  },
  lootably: {
    name: 'Lootably',
    secret: process.env.LOOTABLY_SECRET || 'lootably_demo_secret',
  },
  ayet: {
    name: 'AyetStudios',
    secret: process.env.AYET_SECRET || 'ayet_demo_secret',
  },
};

function getProvider(providerKey) {
  return providers[String(providerKey || '').toLowerCase()] || null;
}

function verifyPostbackSignature({ provider, transactionId, userId, reward, hash }) {
  const config = getProvider(provider);

  if (!config) return false;

  const generatedHash = crypto
    .createHash('sha256')
    .update(`${transactionId}:${userId}:${reward}:${config.secret}`)
    .digest('hex');

  return generatedHash === hash;
}

function generateTestSignature({ provider, transactionId, userId, reward }) {
  const config = getProvider(provider);

  if (!config) return null;

  return crypto
    .createHash('sha256')
    .update(`${transactionId}:${userId}:${reward}:${config.secret}`)
    .digest('hex');
}

function normalizePostback(provider, query = {}) {
  return {
    provider: String(provider || '').toLowerCase(),

    transactionId:
      query.transaction_id ||
      query.tx ||
      query.trans_id ||
      null,

    userId: Number(
      query.user_id ||
      query.uid ||
      query.subid ||
      0
    ),

    reward: Number(
      query.reward ||
      query.amount ||
      0
    ),

    hash:
      query.hash ||
      query.signature ||
      '',
  };
}

module.exports = {
  providers,
  getProvider,
  verifyPostbackSignature,
  generateTestSignature,
  normalizePostback,
};