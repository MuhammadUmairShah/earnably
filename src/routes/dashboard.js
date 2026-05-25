const { Router } = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = Router();

router.get('/stats', requireAuth, async (req, res) => {
  const userId = req.userId;

  const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  const user = userResult.rows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });

  const referralCount = await pool.query(
    'SELECT COUNT(*)::int as count FROM users WHERE referred_by = $1', [userId]
  );

  const referralEarnings = await pool.query(
    `SELECT COALESCE(SUM(amount::numeric), 0) as total FROM transactions
     WHERE user_id = $1 AND type = 'referral_bonus'`, [userId]
  );

  const pendingWithdrawals = await pool.query(
    `SELECT COALESCE(SUM(amount::numeric), 0) as total FROM withdrawals
     WHERE user_id = $1 AND status = 'pending'`, [userId]
  );

  const completedOffers = await pool.query(
    'SELECT COUNT(*)::int as count FROM offer_completions WHERE user_id = $1', [userId]
  );

  const completedTasks = await pool.query(
    'SELECT COUNT(*)::int as count FROM task_completions WHERE user_id = $1', [userId]
  );

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dailyRewardAvailable =
    !user.last_daily_reward || new Date(user.last_daily_reward) < startOfDay;

  const recentTxs = await pool.query(
    'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10', [userId]
  );

  res.json({
    balance: Number(user.balance),
    totalEarned: Number(user.total_earned),
    level: user.level,
    rank: user.rank,
    referralCount: referralCount.rows[0].count,
    referralEarnings: Number(referralEarnings.rows[0].total),
    pendingWithdrawals: Number(pendingWithdrawals.rows[0].total),
    completedOffers: completedOffers.rows[0].count,
    completedTasks: completedTasks.rows[0].count,
    dailyRewardAvailable,
    dailyStreak: user.daily_streak || 0,
    bestDailyStreak: user.best_daily_streak || 0,
    recentTransactions: recentTxs.rows.map(tx => ({
      id: tx.id,
      userId: tx.user_id,
      type: tx.type,
      amount: Number(tx.amount),
      description: tx.description,
      referenceId: tx.reference_id || null,
      referenceType: tx.reference_type || null,
      externalTransactionId: tx.external_transaction_id || null,
      createdAt: new Date(tx.created_at).toISOString(),
    })),
  });
});

module.exports = router;
