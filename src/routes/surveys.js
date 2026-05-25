const { Router } = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { verifyToken } = require('../utils/jwt');

const router = Router();

function toBase64Url(buffer) {
  return buffer
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
    .replaceAll('\n', '');
}

function makeTheoremReachHash(urlBeforeHash, secretKey) {
  return toBase64Url(crypto.createHmac('sha1', secretKey).update(urlBeforeHash).digest());
}

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return String(value).toLowerCase() === 'true';
}

function getUserIdFromRequest(req) {
  if (req.userId) return req.userId;
  if (req.user?.id) return req.user.id;

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7);
  const payload = verifyToken(token);
  return payload?.userId || null;
}

async function getCurrentUser(req) {
  const userId = getUserIdFromRequest(req);
  if (!userId) return null;

  const { rows } = await pool.query(
    'SELECT id, username, email FROM users WHERE id = $1',
    [userId]
  );

  return rows[0] || null;
}

router.get('/cpx-url', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    if (!user?.id) return res.status(401).json({ error: 'Unauthorized' });

    const appId = process.env.CPX_APP_ID;
    const securityHash = process.env.CPX_SECURE_HASH;

    if (!appId || !securityHash) {
      return res.status(500).json({ error: 'CPX is not configured' });
    }

    const userId = String(user.id);
    const secureHash = crypto
      .createHash('md5')
      .update(`${userId}-${securityHash}`)
      .digest('hex');

    const url =
      `https://offers.cpx-research.com/index.php?app_id=${appId}` +
      `&ext_user_id=${encodeURIComponent(userId)}` +
      `&secure_hash=${secureHash}` +
      `&username=${encodeURIComponent(user.username || 'EarnyX User')}` +
      `&email=${encodeURIComponent(user.email || '')}` +
      `&subid_1=&subid_2=`;

    return res.json({ url });
  } catch (error) {
    console.error('CPX URL ERROR:', error);
    return res.status(500).json({ error: 'Failed to create CPX URL' });
  }
});

router.get('/theoremreach-url', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    if (!user?.id) return res.status(401).json({ error: 'Unauthorized' });

    const apiKey = process.env.THEOREMREACH_API_KEY;
    const secretKey = process.env.THEOREMREACH_SECRET_KEY;
    const partnerId = process.env.THEOREMREACH_PARTNER_ID || process.env.THEOREMREACH_APP_ID;

    if (!apiKey || !secretKey || !partnerId) {
      return res.status(500).json({ error: 'TheoremReach is not configured' });
    }

    const userId = String(user.id);
    const transactionId = `tr_${userId}_${Date.now()}`;

    const params = new URLSearchParams({
      external_id: userId,
      user_id: userId,
      transaction_id: transactionId,
      exchange_rate: String(process.env.THEOREMREACH_EXCHANGE_RATE || 1000),
      currency_name_plural: process.env.REWARD_CURRENCY_PLURAL || 'Coins',
      currency_name_singular: process.env.REWARD_CURRENCY_SINGULAR || 'Coin',
      api_key: apiKey,
      partner_id: String(partnerId),
    });

    // Only use debug mode when explicitly enabled in Railway/local env.
    // Production must keep this false so TheoremReach can count real revenue.
    if (boolEnv('THEOREMREACH_DEBUG', false)) {
      params.set('debug', 'true');
    }

    const urlBeforeHash = `https://theoremreach.com/respondent_entry/direct?${params.toString()}`;
    const hash = makeTheoremReachHash(urlBeforeHash, secretKey);
    const url = `${urlBeforeHash}&hash=${hash}`;

    return res.json({
      url,
      transactionId,
      debug: boolEnv('THEOREMREACH_DEBUG', false),
    });
  } catch (error) {
    console.error('THEOREMREACH URL ERROR:', error);
    return res.status(500).json({ error: 'Failed to create TheoremReach URL' });
  }
});

module.exports = router;
