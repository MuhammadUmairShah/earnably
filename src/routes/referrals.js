const { Router } = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = Router();

router.get('/', requireAuth, async (req, res) => {
  const user = (await pool.query('SELECT * FROM users WHERE id = $1', [req.userId])).rows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });

  const referrals = await pool.query(
    'SELECT id, username, created_at FROM users WHERE referred_by = $1 ORDER BY created_at DESC',
    [req.userId]
  );

  const earningsResult = await pool.query(
    `SELECT COALESCE(SUM(amount::numeric), 0) as total FROM transactions
     WHERE user_id = $1 AND type = 'referral_bonus'`, [req.userId]
  );

  const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  res.json({
    referralCode: user.referral_code,
    referralLink: `${baseUrl}/register?ref=${user.referral_code}`,
    totalReferrals: referrals.rows.length,
    totalEarnings: Number(earningsResult.rows[0].total),
    referrals: referrals.rows.map(r => ({
      id: r.id,
      username: r.username,
      joinedAt: new Date(r.created_at).toISOString(),
      earned: 0,
    })),
  });
});

module.exports = router;
