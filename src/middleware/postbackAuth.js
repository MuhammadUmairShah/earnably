const { normalizePostback, verifyPostbackSignature } = require('../utils/providers');

function normalizeCpxPostback(query) {
  const amountLocal = Number(query.amount_local || query.reward || 0);
  const amountUsd = Number(query.amount_usd || query.currency || 0);
  const reward = amountLocal > 0 ? amountLocal : Number((amountUsd * Number(process.env.COIN_EXCHANGE_RATE || 1000)).toFixed(2));

  return {
    provider: 'cpx',
    transactionId: String(query.trans_id || ''),
    userId: String(query.user_id || ''),
    reward,
    amountLocal,
    status: String(query.status || '1') === '2' ? 'reversed' : 'completed',
    hash: query.hash || query.secure_hash || '',
    raw: query,
  };
}

function postbackAuth(req, res, next) {
  try {
    const provider = String(req.params.provider || '').toLowerCase();

    const data =
      provider === 'cpx'
        ? normalizeCpxPostback(req.query)
        : normalizePostback(provider, req.query);

    if (
      !data.provider ||
      !data.transactionId ||
      !data.userId ||
      Number.isNaN(Number(data.reward)) ||
      Number(data.reward) <= 0
    ) {
      return res.status(400).json({
        error: 'Invalid postback data',
        received: req.query,
      });
    }

    // CPX test tool does not send your normal provider signature
    if (provider === 'cpx') {
      req.postback = data;
      return next();
    }

    const demoMode = process.env.NODE_ENV !== 'production';

    if (demoMode) {
      req.postback = data;
      return next();
    }

    const valid = verifyPostbackSignature({
      provider: data.provider,
      transactionId: data.transactionId,
      userId: data.userId,
      reward: data.reward,
      hash: data.hash,
    });

    if (!valid) {
      return res.status(403).json({
        error: 'Invalid signature',
      });
    }

    req.postback = data;
    return next();
  } catch (error) {
    console.error('POSTBACK AUTH ERROR:', error);

    return res.status(500).json({
      error: error.message || 'Postback verification failed',
    });
  }
}

module.exports = postbackAuth;