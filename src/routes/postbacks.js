const { Router } = require('express');
const crypto = require('crypto');
const pool = require('../db');
const postbackAuth = require('../middleware/postbackAuth');

const router = Router();

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return String(value).toLowerCase() === 'true';
}

function base64Url(buffer) {
  return buffer
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
    .replaceAll('\n', '');
}

function makeTheoremReachHash(urlBeforeHash, secretKey) {
  return base64Url(
    crypto.createHmac('sha1', secretKey).update(urlBeforeHash).digest()
  );
}

function makeBitLabsHash(urlBeforeHash, secretKey) {
  return crypto
    .createHmac('sha1', secretKey)
    .update(urlBeforeHash)
    .digest('hex');
}

function stripHashFromUrl(url) {
  return String(url || '')
    .replace(/([?&])hash=[^&]*&?/, '$1')
    .replace(/[?&]$/, '');
}

function constantEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));

  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function getPossiblePublicUrls(req) {
  const originalUrl = req.originalUrl;
  const host = req.get('host');
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const urls = new Set();

  if (process.env.PUBLIC_API_URL) {
    urls.add(`${process.env.PUBLIC_API_URL.replace(/\/$/, '')}${originalUrl}`);
  }

  urls.add(`${proto}://${host}${originalUrl}`);
  urls.add(`https://${host}${originalUrl}`);

  return [...urls].map(stripHashFromUrl);
}

function verifyTheoremReachHash(req) {
  const secretKey = process.env.THEOREMREACH_SECRET_KEY;
  const receivedHash = req.query.hash;

  if (!secretKey || !receivedHash) return false;

  return getPossiblePublicUrls(req).some((urlBeforeHash) => {
    const expectedHash = makeTheoremReachHash(urlBeforeHash, secretKey);
    return constantEqual(receivedHash, expectedHash);
  });
}

function verifyBitLabsHash(req) {
  const secretKey = process.env.BITLABS_SECRET_KEY;
  const receivedHash = req.query.hash;

  if (!secretKey || !receivedHash) return false;

  return getPossiblePublicUrls(req).some((urlBeforeHash) => {
    const expectedHash = makeBitLabsHash(urlBeforeHash, secretKey);
    return constantEqual(
      String(receivedHash).toLowerCase(),
      String(expectedHash).toLowerCase()
    );
  });
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function parseBitLabsPostback(query) {
  const transactionId = firstValue(
    query.tx,
    query.TX,
    query.transaction_id,
    query.transactionId,
    query.transaction,
    query.ref,
    query.REF
  );

  const userId = firstValue(
    query.uid,
    query.UID,
    query.user_id,
    query.userId,
    query.external_id,
    query.subid,
    query.sub_id
  );

  const reward = firstValue(
    query.reward,
    query.val,
    query.VAL,
    query.value,
    query.VALUE,
    query.currency_value,
    query.CURRENCY_VALUE,
    query.points,
    query.amount
  );

  const usd = firstValue(
    query.usd,
    query.USD,
    query.value_usd,
    query.VALUE_USD,
    query.payout
  );

  const type = String(
    firstValue(query.type, query.TYPE, query.status, query.STATUS, 'COMPLETE')
  ).toUpperCase();

  const isReversal =
    type.includes('RECONCILIATION') ||
    type.includes('REVERSE') ||
    type.includes('REVERSED') ||
    type.includes('CHARGEBACK') ||
    Number(reward) < 0;

  return {
    transactionId,
    userId,
    reward,
    usd,
    type,
    isReversal,
  };
}

async function reverseReward({
  client,
  provider,
  transactionId,
  rawData,
  fallbackAmount,
}) {
  await client.query('BEGIN');

  const existing = await client.query(
    'SELECT id, user_id, reward, status FROM offerwall_postbacks WHERE transaction_id = $1',
    [transactionId]
  );

  if (existing.rows.length === 0) {
    await client.query('ROLLBACK');
    return { ignored: true, reason: 'original_not_found' };
  }

  const existingPostback = existing.rows[0];

  if (existingPostback.status === 'reversed') {
    await client.query('ROLLBACK');
    return { ignored: true, reason: 'already_reversed' };
  }

  const reverseAmount = Math.abs(
    Number(existingPostback.reward || fallbackAmount || 0)
  );

  await client.query(
    `UPDATE offerwall_postbacks
     SET status = $1, raw_data = $2
     WHERE transaction_id = $3`,
    ['reversed', JSON.stringify(rawData || {}), transactionId]
  );

  await client.query(
    `UPDATE users
     SET balance = GREATEST(COALESCE(balance, 0) - $1, 0),
         total_earned = GREATEST(COALESCE(total_earned, 0) - $1, 0),
         updated_at = NOW()
     WHERE id = $2`,
    [reverseAmount, existingPostback.user_id]
  );

  await client.query(
    `INSERT INTO transactions
     (user_id, type, amount, description, reference_type, external_transaction_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      existingPostback.user_id,
      'offer_reversal',
      -reverseAmount,
      `${provider.toUpperCase()} reward reversed`,
      provider === 'bitlabs' ? 'survey' : 'offerwall',
      transactionId,
    ]
  );

  try {
    await client.query(
      `INSERT INTO notifications (user_id, title, message, type)
       VALUES ($1, $2, $3, $4)`,
      [
        existingPostback.user_id,
        'Reward reversed',
        `${reverseAmount} Coins from ${provider} were reversed.`,
        'warning',
      ]
    );
  } catch (notificationError) {
    console.error(`${provider} reverse notification skipped:`, notificationError.message);
  }

  await client.query('COMMIT');

  return {
    ignored: false,
    reversed: reverseAmount,
  };
}

async function creditReward({
  client,
  userId,
  provider,
  transactionId,
  amount,
  status,
  rawData,
  transactionType,
  description,
  referenceType,
}) {
  await client.query('BEGIN');

  const existing = await client.query(
    'SELECT id FROM offerwall_postbacks WHERE transaction_id = $1',
    [transactionId]
  );

  if (existing.rows.length > 0) {
    await client.query('ROLLBACK');
    return { duplicate: true };
  }

  const user = await client.query(
    'SELECT id FROM users WHERE id = $1 FOR UPDATE',
    [userId]
  );

  if (!user.rows[0]) {
    await client.query('ROLLBACK');
    const err = new Error('User not found');
    err.status = 404;
    throw err;
  }

  await client.query(
    `INSERT INTO offerwall_postbacks
     (user_id, provider, transaction_id, reward, status, raw_data)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      userId,
      provider,
      transactionId,
      amount,
      status || 'completed',
      JSON.stringify(rawData || {}),
    ]
  );

  await client.query(
    `UPDATE users
     SET balance = COALESCE(balance, 0) + $1,
         total_earned = COALESCE(total_earned, 0) + $1,
         updated_at = NOW()
     WHERE id = $2`,
    [amount, userId]
  );

  await client.query(
    `INSERT INTO transactions
     (user_id, type, amount, description, reference_type, external_transaction_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, transactionType, amount, description, referenceType, transactionId]
  );

  try {
    await client.query(
      `INSERT INTO notifications (user_id, title, message, type)
       VALUES ($1, $2, $3, $4)`,
      [
        userId,
        'Reward credited',
        `You earned ${amount} Coins from ${provider}.`,
        'reward',
      ]
    );
  } catch (notificationError) {
    console.error(`${provider} notification skipped:`, notificationError.message);
  }

  await client.query('COMMIT');
  return { duplicate: false };
}

router.get('/theoremreach', async (req, res) => {
  const client = await pool.connect();

  try {
    console.log('THEOREMREACH CALLBACK RECEIVED:', req.query);

    const transactionId =
      req.query.transaction_id || req.query.tx_id || req.query.transactionId;

    const userId = req.query.user_id || req.query.external_id || null;
    const reward = req.query.reward;
    const debug = String(req.query.debug || '').toLowerCase() === 'true';
    const status = String(req.query.status || 'completed');

    if (!transactionId || !userId || reward === undefined) {
      return res.status(400).json({
        error: 'Invalid TheoremReach postback data',
        received: req.query,
      });
    }

    if (!req.query.hash) {
      return res.status(403).json({
        error: 'Missing TheoremReach hash',
        received: req.query,
      });
    }

    const skipHash = boolEnv('THEOREMREACH_SKIP_HASH', true);
    const hashOk = skipHash || verifyTheoremReachHash(req);

    if (!hashOk) {
      return res.status(403).json({
        error: 'Invalid TheoremReach hash',
        received: req.query,
        hint:
          'Set PUBLIC_API_URL=https://earnably-api-production.up.railway.app or temporarily set THEOREMREACH_SKIP_HASH=true.',
      });
    }

    if (debug && !boolEnv('THEOREMREACH_CREDIT_DEBUG', false)) {
      return res.json({
        success: true,
        message:
          'Debug callback accepted and ignored. Set THEOREMREACH_CREDIT_DEBUG=true only for testing.',
        received: req.query,
      });
    }

    const amount = Number(reward);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        error: 'Invalid reward amount',
        received: req.query,
      });
    }

    const result = await creditReward({
      client,
      userId,
      provider: 'theoremreach',
      transactionId: String(transactionId),
      amount,
      status,
      rawData: req.query,
      transactionType: 'survey_completion',
      description: 'THEOREMREACH survey completed',
      referenceType: 'survey',
    });

    if (result.duplicate) {
      return res.status(200).json({
        message: 'Duplicate ignored',
        transactionId,
      });
    }

    return res.json({
      success: true,
      credited: amount,
      provider: 'theoremreach',
      transactionId,
      userId,
      debug,
    });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {}

    console.error('THEOREMREACH POSTBACK ERROR:', error);

    return res.status(error.status || 500).json({
      error: error.message || 'Failed to process TheoremReach postback',
    });
  } finally {
    client.release();
  }
});

router.get('/bitlabs', async (req, res) => {
  const client = await pool.connect();

  try {
    console.log('BITLABS CALLBACK RECEIVED:', req.query);

    const parsed = parseBitLabsPostback(req.query);
    const { transactionId, userId, reward, usd, type, isReversal } = parsed;

    if (!transactionId || !userId || reward === undefined) {
      return res.status(400).json({
        error: 'Invalid BitLabs postback data',
        required: ['uid', 'tx', 'reward'],
        received: req.query,
      });
    }

    const skipHash = boolEnv('BITLABS_SKIP_HASH', true);
    const hashOk = skipHash || verifyBitLabsHash(req);

    if (!hashOk) {
      return res.status(403).json({
        error: 'Invalid BitLabs hash',
        received: req.query,
        hint:
          'Set PUBLIC_API_URL=https://earnably-api-production.up.railway.app or temporarily set BITLABS_SKIP_HASH=true.',
      });
    }

    const amount = Math.abs(Number(reward));

    if (isReversal) {
      const reverseResult = await reverseReward({
        client,
        provider: 'bitlabs',
        transactionId: String(transactionId),
        rawData: req.query,
        fallbackAmount: amount,
      });

      if (reverseResult.ignored) {
        return res.status(200).json({
          message: 'BitLabs reverse ignored',
          reason: reverseResult.reason,
          transactionId,
        });
      }

      return res.json({
        success: true,
        provider: 'bitlabs',
        reversed: reverseResult.reversed,
        transactionId,
        userId,
        type,
      });
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        error: 'Invalid BitLabs reward amount',
        received: req.query,
      });
    }

    const result = await creditReward({
      client,
      userId,
      provider: 'bitlabs',
      transactionId: String(transactionId),
      amount,
      status: 'completed',
      rawData: {
        ...req.query,
        parsed: {
          usd,
          type,
        },
      },
      transactionType: 'survey_completion',
      description: 'BITLABS survey completed',
      referenceType: 'survey',
    });

    if (result.duplicate) {
      return res.status(200).json({
        message: 'Duplicate ignored',
        transactionId,
      });
    }

    return res.json({
      success: true,
      credited: amount,
      provider: 'bitlabs',
      transactionId,
      userId,
      usd,
      type,
    });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {}

    console.error('BITLABS POSTBACK ERROR:', error);

    return res.status(error.status || 500).json({
      error: error.message || 'Failed to process BitLabs postback',
    });
  } finally {
    client.release();
  }
});

router.get('/:provider', postbackAuth, async (req, res) => {
  const client = await pool.connect();

  try {
    const { provider, transactionId, userId, reward, status } = req.postback;

    if (status === 'reversed') {
      const reverseResult = await reverseReward({
        client,
        provider,
        transactionId,
        rawData: req.query,
        fallbackAmount: Number(reward),
      });

      if (reverseResult.ignored) {
        return res.status(200).json({
          message:
            reverseResult.reason === 'original_not_found'
              ? 'Reverse ignored: original not found'
              : 'Duplicate reverse ignored',
        });
      }

      return res.json({
        success: true,
        reversed: reverseResult.reversed,
      });
    }

    const result = await creditReward({
      client,
      userId,
      provider,
      transactionId,
      amount: Number(reward),
      status: 'completed',
      rawData: req.query,
      transactionType: provider === 'cpx' ? 'survey_completion' : 'offer_completion',
      description: `${provider.toUpperCase()} ${
        provider === 'cpx' ? 'survey' : 'offer'
      } completed`,
      referenceType: provider === 'cpx' ? 'survey' : 'offerwall',
    });

    if (result.duplicate) {
      return res.status(200).json({
        message: 'Duplicate ignored',
      });
    }

    return res.json({
      success: true,
      credited: Number(reward),
    });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {}

    console.error('POSTBACK ERROR:', error);

    return res.status(error.status || 500).json({
      error: error.message || 'Failed to process postback',
    });
  } finally {
    client.release();
  }
});

module.exports = router;