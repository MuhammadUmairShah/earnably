const { Router } = require('express');
const pool = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { computeLevel } = require('../utils/referral');

const router = Router();

async function safeNotify(client, userId, title, message, type = 'system') {
  try {
    await client.query(
      `INSERT INTO notifications (user_id, title, message, type)
       VALUES ($1, $2, $3, $4)`,
      [userId, title, message, type]
    );
  } catch (error) {
    console.error('Notification skipped:', error.message);
  }
}

function makeSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function fmtProvider(p) {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    wallUrl: p.wall_url || '',
    apiKey: p.api_key || '',
    postbackSecret: p.postback_secret || '',
    isActive: Boolean(p.is_active),
    createdAt: p.created_at ? new Date(p.created_at).toISOString() : null,
    updatedAt: p.updated_at ? new Date(p.updated_at).toISOString() : null,
  };
}

function fmtUser(u, totalWithdrawals = 0, totalReferrals = 0) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    balance: Number(u.balance || 0),
    totalEarned: Number(u.total_earned || 0),
    level: u.level,
    rank: u.rank,
    referralCode: u.referral_code,
    role: u.role,
    isBanned: u.is_banned,
    lastDailyReward: u.last_daily_reward
      ? new Date(u.last_daily_reward).toISOString()
      : null,
    createdAt: new Date(u.created_at).toISOString(),
    totalWithdrawals: Number(totalWithdrawals || 0),
    totalReferrals: Number(totalReferrals || 0),
  };
}

function fmtWithdrawal(w) {
  return {
    id: w.id,
    userId: w.user_id,
    username: w.username || null,
    email: w.email || null,
    amount: Number(w.amount || 0),
    method: w.method,
    accountDetails: w.account_details,
    status: w.status,
    emailConfirmed: Boolean(w.email_confirmed),
    securityNote: w.security_note || null,
    rejectionReason: w.rejection_reason || null,
    createdAt: new Date(w.created_at).toISOString(),
    processedAt: w.processed_at ? new Date(w.processed_at).toISOString() : null,
  };
}

function fmtOffer(o) {
  return {
    id: o.id,
    title: o.title,
    description: o.description,
    provider: o.provider,
    category: o.category,
    reward: Number(o.reward),
    offerUrl: o.offer_url || null,
    imageUrl: o.image_url || '',
    isActive: o.is_active,
    difficulty: o.difficulty,
    estimatedTime: o.estimated_time || null,
    createdAt: new Date(o.created_at).toISOString(),
  };
}

/* USERS */

router.get('/users', requireAdmin, async (req, res) => {
  const { search } = req.query;
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;

  let query = 'SELECT * FROM users';
  const params = [];

  if (search) {
    params.push(`%${search}%`);
    query += ` WHERE username ILIKE $1 OR email ILIKE $1`;
  }

  query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);

  const users = await pool.query(query, params);

  const results = await Promise.all(
    users.rows.map(async (u) => {
      const wr = await pool.query(
        `SELECT COALESCE(SUM(amount::numeric), 0) as total
         FROM withdrawals
         WHERE user_id = $1 AND status = 'approved'`,
        [u.id]
      );

      const rr = await pool.query(
        'SELECT COUNT(*)::int as count FROM users WHERE referred_by = $1',
        [u.id]
      );

      return fmtUser(u, wr.rows[0].total, rr.rows[0].count);
    })
  );

  res.json(results);
});

router.patch('/users/:id/ban', requireAdmin, async (req, res) => {
  const { isBanned } = req.body;

  const result = await pool.query(
    'UPDATE users SET is_banned = $1 WHERE id = $2 RETURNING *',
    [isBanned, parseInt(req.params.id)]
  );

  if (!result.rows.length) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json(fmtUser(result.rows[0]));
});

router.post('/users/:id/reward', requireAdmin, async (req, res) => {
  const { amount, description } = req.body;
  const userId = parseInt(req.params.id);
  const amountValue = Number(amount);

  if (!amountValue || Number.isNaN(amountValue) || amountValue <= 0) {
    return res.status(400).json({ error: 'Invalid reward amount' });
  }

  const user = (
    await pool.query('SELECT id FROM users WHERE id = $1', [userId])
  ).rows[0];

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  await pool.query(
    `UPDATE users
     SET balance = COALESCE(balance, 0) + $1,
         total_earned = COALESCE(total_earned, 0) + $1
     WHERE id = $2`,
    [amountValue, userId]
  );

  const updated = (
    await pool.query('SELECT * FROM users WHERE id = $1', [userId])
  ).rows[0];

  const { level, rank } = computeLevel(Number(updated.total_earned || 0));

  await pool.query('UPDATE users SET level = $1, rank = $2 WHERE id = $3', [
    level,
    rank,
    userId,
  ]);

  const tx = await pool.query(
    `INSERT INTO transactions (user_id, type, amount, description, reference_type)
     VALUES ($1, 'manual_reward', $2, $3, 'admin')
     RETURNING *`,
    [userId, amountValue, description || 'Admin reward']
  );

  const t = tx.rows[0];

  res.json({
    id: t.id,
    userId: t.user_id,
    type: t.type,
    amount: Number(t.amount),
    description: t.description,
    referenceId: null,
    referenceType: t.reference_type || null,
    createdAt: new Date(t.created_at).toISOString(),
  });
});

/* WITHDRAWALS */

router.get('/withdrawals', requireAdmin, async (req, res) => {
  const { status } = req.query;

  let query = `
    SELECT w.*, u.username, u.email
    FROM withdrawals w
    LEFT JOIN users u ON w.user_id = u.id
  `;

  const params = [];

  if (status) {
    params.push(status);
    query += ` WHERE w.status = $1`;
  }

  query += ' ORDER BY w.created_at DESC';

  const result = await pool.query(query, params);

  res.json(result.rows.map(fmtWithdrawal));
});

router.patch('/withdrawals/:id/approve', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existing = (
      await client.query(
        `SELECT *
         FROM withdrawals
         WHERE id = $1
         FOR UPDATE`,
        [id]
      )
    ).rows[0];

    if (!existing) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Withdrawal not found' });
    }

    if (existing.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Withdrawal already ${existing.status}`,
      });
    }

    const result = await client.query(
      `UPDATE withdrawals
       SET status = 'approved',
           rejection_reason = NULL,
           processed_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    await safeNotify(
      client,
      existing.user_id,
      'Withdrawal approved',
      `Your ${existing.method} withdrawal for $${Number(existing.amount).toFixed(2)} was approved.`,
      'withdrawal'
    );

    await client.query('COMMIT');

    res.json(
      fmtWithdrawal({
        ...result.rows[0],
        username: null,
        email: null,
      })
    );
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Approve withdrawal error:', error);
    res.status(500).json({
      error: error.message || 'Failed to approve withdrawal',
    });
  } finally {
    client.release();
  }
});

router.patch('/withdrawals/:id/reject', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const reason = String(req.body.reason || 'Rejected by admin').trim();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existing = (
      await client.query(
        `SELECT *
         FROM withdrawals
         WHERE id = $1
         FOR UPDATE`,
        [id]
      )
    ).rows[0];

    if (!existing) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Withdrawal not found' });
    }

    if (existing.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Withdrawal already ${existing.status}`,
      });
    }

    await client.query(
      `UPDATE users
       SET balance = COALESCE(balance, 0) + $1
       WHERE id = $2`,
      [existing.amount, existing.user_id]
    );

    const result = await client.query(
      `UPDATE withdrawals
       SET status = 'rejected',
           rejection_reason = $1,
           processed_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [reason, id]
    );

    await client.query(
      `INSERT INTO transactions
       (user_id, type, amount, description, reference_id, reference_type)
       VALUES ($1, 'withdrawal_refund', $2, $3, $4, 'withdrawal')`,
      [
        existing.user_id,
        Number(existing.amount),
        `Withdrawal refunded: ${reason}`,
        existing.id,
      ]
    );

    await safeNotify(
      client,
      existing.user_id,
      'Withdrawal rejected',
      `Your withdrawal was rejected: ${reason}`,
      'withdrawal'
    );

    await client.query('COMMIT');

    res.json(
      fmtWithdrawal({
        ...result.rows[0],
        username: null,
        email: null,
      })
    );
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Reject withdrawal error:', error);
    res.status(500).json({
      error: error.message || 'Failed to reject withdrawal',
    });
  } finally {
    client.release();
  }
});

/* ANALYTICS */

router.get('/analytics', requireAdmin, async (req, res) => {
  const [totalUsers, paidOut, pendingAmt, approvedAmt, activeOffers] =
    await Promise.all([
      pool.query('SELECT COUNT(*)::int as count FROM users'),
      pool.query(
        `SELECT COALESCE(SUM(amount::numeric), 0) as total FROM withdrawals WHERE status = 'approved'`
      ),
      pool.query(
        `SELECT COALESCE(SUM(amount::numeric), 0) as total FROM withdrawals WHERE status = 'pending'`
      ),
      pool.query(
        `SELECT COALESCE(SUM(amount::numeric), 0) as total FROM withdrawals WHERE status = 'approved'`
      ),
      pool.query('SELECT COUNT(*)::int as count FROM offers WHERE is_active = true'),
    ]);

  const dailySignups = await pool.query(`
    SELECT DATE(created_at AT TIME ZONE 'UTC') as date, COUNT(*)::int as value
    FROM users
    WHERE created_at >= NOW() - INTERVAL '7 days'
    GROUP BY DATE(created_at AT TIME ZONE 'UTC')
    ORDER BY date ASC
  `);

  const dailyEarnings = await pool.query(`
    SELECT DATE(created_at AT TIME ZONE 'UTC') as date, COALESCE(SUM(amount::numeric), 0) as value
    FROM transactions
    WHERE created_at >= NOW() - INTERVAL '7 days'
      AND type IN ('offer_completion', 'task_completion', 'daily_reward', 'manual_reward', 'profile_bonus')
    GROUP BY DATE(created_at AT TIME ZONE 'UTC')
    ORDER BY date ASC
  `);

  res.json({
    totalUsers: totalUsers.rows[0].count,
    totalEarningsPaid: Number(paidOut.rows[0].total),
    totalWithdrawalsPending: Number(pendingAmt.rows[0].total),
    totalWithdrawalsApproved: Number(approvedAmt.rows[0].total),
    activeOffers: activeOffers.rows[0].count,
    activeTasks: 0,
    dailySignups: dailySignups.rows.map((r) => ({
      date: String(r.date),
      value: Number(r.value),
    })),
    dailyEarnings: dailyEarnings.rows.map((r) => ({
      date: String(r.date),
      value: Number(r.value),
    })),
  });
});

/* OFFERWALL PROVIDER SETTINGS */

router.get('/offerwall-providers', requireAdmin, async (req, res) => {
  const result = await pool.query(
    `SELECT *
     FROM offerwall_providers
     ORDER BY created_at DESC`
  );

  res.json(result.rows.map(fmtProvider));
});

router.post('/offerwall-providers', requireAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const slug = makeSlug(req.body.slug || name);
  const wallUrl = String(req.body.wallUrl || '').trim();
  const apiKey = String(req.body.apiKey || '').trim();
  const postbackSecret = String(req.body.postbackSecret || '').trim();
  const isActive = req.body.isActive !== undefined ? Boolean(req.body.isActive) : true;

  if (!name || !slug) {
    return res.status(400).json({
      error: 'Provider name is required',
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO offerwall_providers
       (name, slug, wall_url, api_key, postback_secret, is_active)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        name,
        slug,
        wallUrl || null,
        apiKey || null,
        postbackSecret || null,
        isActive,
      ]
    );

    res.status(201).json(fmtProvider(result.rows[0]));
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({
        error: 'Provider slug already exists',
      });
    }

    console.error('Create provider error:', error);

    res.status(500).json({
      error: 'Failed to create provider',
    });
  }
});

router.patch('/offerwall-providers/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);

  const name = req.body.name !== undefined ? String(req.body.name || '').trim() : undefined;
  const slug = req.body.slug !== undefined ? makeSlug(req.body.slug) : undefined;
  const wallUrl = req.body.wallUrl !== undefined ? String(req.body.wallUrl || '').trim() : undefined;
  const apiKey = req.body.apiKey !== undefined ? String(req.body.apiKey || '').trim() : undefined;
  const postbackSecret =
    req.body.postbackSecret !== undefined ? String(req.body.postbackSecret || '').trim() : undefined;
  const isActive = req.body.isActive !== undefined ? Boolean(req.body.isActive) : undefined;

  const updates = [];
  const params = [];

  if (name !== undefined) {
    if (!name) {
      return res.status(400).json({ error: 'Provider name cannot be empty' });
    }

    params.push(name);
    updates.push(`name = $${params.length}`);
  }

  if (slug !== undefined) {
    if (!slug) {
      return res.status(400).json({ error: 'Provider slug cannot be empty' });
    }

    params.push(slug);
    updates.push(`slug = $${params.length}`);
  }

  if (wallUrl !== undefined) {
    params.push(wallUrl || null);
    updates.push(`wall_url = $${params.length}`);
  }

  if (apiKey !== undefined) {
    params.push(apiKey || null);
    updates.push(`api_key = $${params.length}`);
  }

  if (postbackSecret !== undefined) {
    params.push(postbackSecret || null);
    updates.push(`postback_secret = $${params.length}`);
  }

  if (isActive !== undefined) {
    params.push(isActive);
    updates.push(`is_active = $${params.length}`);
  }

  if (!updates.length) {
    return res.status(400).json({
      error: 'No fields to update',
    });
  }

  updates.push(`updated_at = NOW()`);

  params.push(id);

  try {
    const result = await pool.query(
      `UPDATE offerwall_providers
       SET ${updates.join(', ')}
       WHERE id = $${params.length}
       RETURNING *`,
      params
    );

    if (!result.rows[0]) {
      return res.status(404).json({
        error: 'Provider not found',
      });
    }

    res.json(fmtProvider(result.rows[0]));
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({
        error: 'Provider slug already exists',
      });
    }

    console.error('Update provider error:', error);

    res.status(500).json({
      error: 'Failed to update provider',
    });
  }
});

router.patch('/offerwall-providers/:id/toggle', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);

  const result = await pool.query(
    `UPDATE offerwall_providers
     SET is_active = NOT is_active,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id]
  );

  if (!result.rows[0]) {
    return res.status(404).json({
      error: 'Provider not found',
    });
  }

  res.json(fmtProvider(result.rows[0]));
});

router.delete('/offerwall-providers/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);

  const result = await pool.query(
    `DELETE FROM offerwall_providers
     WHERE id = $1
     RETURNING id`,
    [id]
  );

  if (!result.rows[0]) {
    return res.status(404).json({
      error: 'Provider not found',
    });
  }

  res.json({
    message: 'Provider deleted successfully',
  });
});

/* OFFERS */

router.get('/offers', requireAdmin, async (req, res) => {
  const result = await pool.query('SELECT * FROM offers ORDER BY created_at DESC');
  res.json(result.rows.map(fmtOffer));
});

router.post('/offers', requireAdmin, async (req, res) => {
  const {
    title,
    description,
    provider,
    category,
    reward,
    offerUrl,
    imageUrl,
    difficulty,
    estimatedTime,
    isActive,
  } = req.body;

  if (!title || !provider || !category || reward === undefined) {
    return res.status(400).json({
      error: 'Title, provider, category, and reward are required',
    });
  }

  const result = await pool.query(
    `INSERT INTO offers
      (title, description, provider, category, reward, offer_url, image_url, difficulty, estimated_time, is_active)
     VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      title,
      description || '',
      provider,
      category,
      reward,
      offerUrl || null,
      imageUrl || '',
      difficulty || 'easy',
      estimatedTime || null,
      isActive !== undefined ? isActive : true,
    ]
  );

  res.status(201).json(fmtOffer(result.rows[0]));
});

router.patch('/offers/:id', requireAdmin, async (req, res) => {
  const {
    title,
    description,
    provider,
    category,
    reward,
    offerUrl,
    imageUrl,
    isActive,
    difficulty,
    estimatedTime,
  } = req.body;

  const updates = [];
  const params = [];

  if (title !== undefined) {
    params.push(title);
    updates.push(`title = $${params.length}`);
  }

  if (description !== undefined) {
    params.push(description);
    updates.push(`description = $${params.length}`);
  }

  if (provider !== undefined) {
    params.push(provider);
    updates.push(`provider = $${params.length}`);
  }

  if (category !== undefined) {
    params.push(category);
    updates.push(`category = $${params.length}`);
  }

  if (reward !== undefined) {
    params.push(reward);
    updates.push(`reward = $${params.length}`);
  }

  if (offerUrl !== undefined) {
    params.push(offerUrl || null);
    updates.push(`offer_url = $${params.length}`);
  }

  if (imageUrl !== undefined) {
    params.push(imageUrl || '');
    updates.push(`image_url = $${params.length}`);
  }

  if (isActive !== undefined) {
    params.push(isActive);
    updates.push(`is_active = $${params.length}`);
  }

  if (difficulty !== undefined) {
    params.push(difficulty);
    updates.push(`difficulty = $${params.length}`);
  }

  if (estimatedTime !== undefined) {
    params.push(estimatedTime || null);
    updates.push(`estimated_time = $${params.length}`);
  }

  if (!updates.length) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  params.push(parseInt(req.params.id));

  const result = await pool.query(
    `UPDATE offers
     SET ${updates.join(', ')}
     WHERE id = $${params.length}
     RETURNING *`,
    params
  );

  if (!result.rows.length) {
    return res.status(404).json({ error: 'Offer not found' });
  }

  res.json(fmtOffer(result.rows[0]));
});

router.delete('/offers/:id', requireAdmin, async (req, res) => {
  const result = await pool.query(
    'DELETE FROM offers WHERE id = $1 RETURNING id',
    [parseInt(req.params.id)]
  );

  if (!result.rows.length) {
    return res.status(404).json({ error: 'Offer not found' });
  }

  res.sendStatus(204);
});

module.exports = router;