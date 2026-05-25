const { Router } = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { computeLevel, REFERRAL_COMMISSION_RATE } = require('../utils/referral');

const router = Router();

function buildProviderUrl(url, user) {
  if (!url) return '';

  const transactionId = `ow_${user.id}_${Date.now()}`;

  return url
    .replaceAll('{USER_ID}', encodeURIComponent(user.id))
    .replaceAll('{USERNAME}', encodeURIComponent(user.username || 'EarnyX User'))
    .replaceAll('{EMAIL}', encodeURIComponent(user.email || ''))
    .replaceAll('{TRANSACTION_ID}', encodeURIComponent(transactionId));
}

async function getCurrentUser(userId) {
  const { rows } = await pool.query(
    'SELECT id, username, email, referred_by, total_earned FROM users WHERE id = $1',
    [userId]
  );

  return rows[0] || null;
}

function formatOffer(o) {
  return {
    id: o.id,
    title: o.title,
    description: o.description,
    provider: o.provider,
    category: o.category,
    reward: Number(o.reward),
    offerUrl: o.offer_url || null,
    imageUrl: o.image_url,
    isActive: o.is_active,
    difficulty: o.difficulty,
    estimatedTime: o.estimated_time || null,
    createdAt: new Date(o.created_at).toISOString(),
  };
}

function formatProvider(p, user) {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    wallUrl: buildProviderUrl(p.wall_url || '', user),
    isActive: Boolean(p.is_active),
    createdAt: p.created_at ? new Date(p.created_at).toISOString() : null,
  };
}

router.get('/providers', requireAuth, async (req, res) => {
  try {
    const user = await getCurrentUser(req.userId);

    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const result = await pool.query(
      `SELECT id, name, slug, wall_url, is_active, created_at
       FROM offerwall_providers
       WHERE is_active = true
       ORDER BY created_at DESC`
    );

    return res.json(result.rows.map((p) => formatProvider(p, user)));
  } catch (error) {
    console.error('OFFERWALL PROVIDERS ERROR:', error);

    return res.status(500).json({
      error: error.message || 'Failed to load offerwall providers',
    });
  }
});

router.get('/provider/:slug/url', requireAuth, async (req, res) => {
  try {
    const user = await getCurrentUser(req.userId);

    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { rows } = await pool.query(
      `SELECT id, name, slug, wall_url, is_active
       FROM offerwall_providers
       WHERE slug = $1 AND is_active = true
       LIMIT 1`,
      [String(req.params.slug || '').toLowerCase()]
    );

    const provider = rows[0];

    if (!provider || !provider.wall_url) {
      return res.status(404).json({ error: 'Provider not found or inactive' });
    }

    return res.json({
      provider: provider.slug,
      url: buildProviderUrl(provider.wall_url, user),
    });
  } catch (error) {
    console.error('PROVIDER URL ERROR:', error);

    return res.status(500).json({
      error: error.message || 'Failed to create provider URL',
    });
  }
});

router.get('/', requireAuth, async (req, res) => {
  const { provider, category } = req.query;

  let query = 'SELECT * FROM offers WHERE is_active = true';
  const params = [];

  if (provider) {
    params.push(provider);
    query += ` AND provider = $${params.length}`;
  }

  if (category) {
    params.push(category);
    query += ` AND category = $${params.length}`;
  }

  query += ' ORDER BY created_at DESC';

  const result = await pool.query(query, params);

  res.json(result.rows.map(formatOffer));
});

router.post('/:id/click', requireAuth, async (req, res) => {
  const offerId = parseInt(req.params.id);

  const offer = await pool.query('SELECT * FROM offers WHERE id = $1', [offerId]);

  if (!offer.rows.length) {
    return res.status(404).json({ error: 'Offer not found' });
  }

  await pool.query(
    'INSERT INTO offer_clicks (offer_id, user_id) VALUES ($1, $2)',
    [offerId, req.userId]
  );

  const o = offer.rows[0];
  const provider = String(o.provider || '').toLowerCase();

  let url = o.offer_url;

  if (!url) {
    url = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/offerwalls?demo=1&provider=${provider}&offer=${o.id}`;
  }

  res.json({
    url,
    offerId: o.id,
    mode: o.offer_url ? 'real-ready' : 'demo',
  });
});

router.post('/:id/complete', requireAuth, async (req, res) => {
  const offerId = parseInt(req.params.id);

  const offer = await pool.query('SELECT * FROM offers WHERE id = $1', [offerId]);

  if (!offer.rows.length) {
    return res.status(404).json({ error: 'Offer not found' });
  }

  const o = offer.rows[0];
  const targetUserId = req.userId;

  const existing = await pool.query(
    'SELECT id FROM offer_completions WHERE offer_id = $1 AND user_id = $2',
    [offerId, targetUserId]
  );

  if (existing.rows.length > 0) {
    return res.status(400).json({ error: 'Offer already completed' });
  }

  await pool.query(
    'INSERT INTO offer_completions (offer_id, user_id, external_transaction_id) VALUES ($1, $2, $3)',
    [offerId, targetUserId, req.body.transactionId || null]
  );

  const reward = Number(o.reward);

  await pool.query(
    `UPDATE users
     SET balance = COALESCE(balance, 0) + $1,
         total_earned = COALESCE(total_earned, 0) + $1
     WHERE id = $2`,
    [reward, targetUserId]
  );

  const updatedUser = (
    await pool.query('SELECT * FROM users WHERE id = $1', [targetUserId])
  ).rows[0];

  const { level, rank } = computeLevel(Number(updatedUser.total_earned || 0));

  await pool.query('UPDATE users SET level = $1, rank = $2 WHERE id = $3', [
    level,
    rank,
    targetUserId,
  ]);

  if (updatedUser.referred_by) {
    const commission = reward * REFERRAL_COMMISSION_RATE;

    await pool.query(
      `UPDATE users
       SET balance = COALESCE(balance, 0) + $1,
           total_earned = COALESCE(total_earned, 0) + $1
       WHERE id = $2`,
      [commission, updatedUser.referred_by]
    );

    await pool.query(
      `INSERT INTO transactions
       (user_id, type, amount, description, reference_id, reference_type)
       VALUES ($1, 'referral_bonus', $2, $3, $4, 'referral')`,
      [
        updatedUser.referred_by,
        commission,
        `Referral commission from ${updatedUser.username}`,
        targetUserId,
      ]
    );
  }

  try {
    await pool.query(
      `INSERT INTO notifications
       (user_id, title, message, type)
       VALUES ($1, 'Offer credited', $2, 'reward')`,
      [targetUserId, `You earned $${reward.toFixed(2)} from ${o.title}.`]
    );
  } catch (error) {
    console.error('Offer notification skipped:', error.message);
  }

  const tx = await pool.query(
    `INSERT INTO transactions
     (user_id, type, amount, description, reference_id, reference_type, external_transaction_id)
     VALUES ($1, 'offer_completion', $2, $3, $4, 'offer', $5)
     RETURNING *`,
    [
      targetUserId,
      reward,
      `Completed offer: ${o.title}`,
      offerId,
      req.body.transactionId || null,
    ]
  );

  const t = tx.rows[0];

  res.json({
    id: t.id,
    userId: t.user_id,
    type: t.type,
    amount: Number(t.amount),
    description: t.description,
    referenceId: t.reference_id || null,
    referenceType: t.reference_type || null,
    createdAt: new Date(t.created_at).toISOString(),
  });
});

module.exports = router;