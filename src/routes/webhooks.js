const { Router } = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { computeLevel, REFERRAL_COMMISSION_RATE } = require('../utils/referral');

const router = Router();

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function creditUser({ userId, amount, description, referenceId, referenceType, externalTransactionId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (externalTransactionId) {
      const existing = await client.query(
        'SELECT id FROM transactions WHERE reference_type = $1 AND external_transaction_id = $2',
        [referenceType, externalTransactionId]
      );
      if (existing.rows.length) {
        await client.query('ROLLBACK');
        return { duplicate: true };
      }
    }

    const userResult = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const user = userResult.rows[0];
    if (!user || user.is_banned) throw Object.assign(new Error('User not found or banned'), { status: 404 });

    const reward = Number(amount);
    if (!Number.isFinite(reward) || reward <= 0) throw Object.assign(new Error('Invalid reward amount'), { status: 400 });

    const updated = await client.query(
      'UPDATE users SET balance = balance + $1, total_earned = total_earned + $1 WHERE id = $2 RETURNING *',
      [reward, userId]
    );
    const { level, rank } = computeLevel(Number(updated.rows[0].total_earned));
    await client.query('UPDATE users SET level = $1, rank = $2 WHERE id = $3', [level, rank, userId]);

    const tx = await client.query(
      `INSERT INTO transactions (user_id, type, amount, description, reference_id, reference_type, external_transaction_id)
       VALUES ($1, 'offer_completion', $2, $3, $4, $5, $6) RETURNING *`,
      [userId, reward, description, referenceId || null, referenceType, externalTransactionId || null]
    );

    if (user.referred_by) {
      const commission = Number((reward * REFERRAL_COMMISSION_RATE).toFixed(2));
      if (commission > 0) {
        await client.query(
          'UPDATE users SET balance = balance + $1, total_earned = total_earned + $1 WHERE id = $2',
          [commission, user.referred_by]
        );
        await client.query(
          `INSERT INTO transactions (user_id, type, amount, description, reference_id, reference_type)
           VALUES ($1, 'referral_bonus', $2, $3, $4, 'referral')`,
          [user.referred_by, commission, `Referral commission from ${user.username}`, userId]
        );
      }
    }

    await client.query('COMMIT');
    return { duplicate: false, transaction: tx.rows[0] };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Generic secure callback for real offerwall providers.
// Configure OFFERWALL_CALLBACK_SECRET and pass ?secret=... from the provider dashboard.
router.post('/offerwall/:provider', async (req, res) => {
  const callbackSecret = process.env.OFFERWALL_CALLBACK_SECRET;
  if (callbackSecret && !safeEqual(req.query.secret, callbackSecret)) {
    return res.status(401).json({ error: 'Invalid callback secret' });
  }

  const provider = String(req.params.provider || '').toLowerCase();
  const body = req.body || {};
  const userId = Number(body.userId || body.subId || body.uid);
  const amount = Number(body.reward || body.amount || body.payout);
  const externalTransactionId = String(body.transactionId || body.txid || body.id || '');
  const offerName = body.offerName || body.offer || `${provider} offer`;

  const result = await creditUser({
    userId,
    amount,
    description: `Completed ${offerName}`,
    referenceId: null,
    referenceType: provider || 'offerwall',
    externalTransactionId,
  });

  res.json({ ok: true, duplicate: result.duplicate });
});

module.exports = router;
