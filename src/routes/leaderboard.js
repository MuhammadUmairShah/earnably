const { Router } = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = Router();

router.get('/', requireAuth, async (req, res) => {
  const period = ['daily', 'weekly', 'monthly', 'all'].includes(req.query.period)
    ? req.query.period
    : 'weekly';

  const intervalMap = {
    daily: '1 day',
    weekly: '7 days',
    monthly: '30 days',
  };

  const rewardTypes = [
    'offer_completion',
    'task_completion',
    'daily_reward',
    'manual_reward',
    'referral_bonus',
  ];

  const where =
    period === 'all'
      ? `t.type = ANY($1)`
      : `t.created_at >= NOW() - INTERVAL '${intervalMap[period]}' AND t.type = ANY($1)`;

  const result = await pool.query(
    `
    SELECT
      u.id,
      u.username,
      u.rank,
      u.level,
      COALESCE(SUM(t.amount::numeric), 0) AS earned
    FROM users u
    LEFT JOIN transactions t
      ON t.user_id = u.id
      AND ${where}
    WHERE u.is_banned = false
    GROUP BY u.id, u.username, u.rank, u.level
    HAVING COALESCE(SUM(t.amount::numeric), 0) > 0
    ORDER BY earned DESC
    LIMIT 50
    `,
    [rewardTypes]
  );

  const current = await pool.query(
    `
    SELECT position, earned
    FROM (
      SELECT
        u.id,
        ROW_NUMBER() OVER (
          ORDER BY COALESCE(SUM(t.amount::numeric), 0) DESC
        ) AS position,
        COALESCE(SUM(t.amount::numeric), 0) AS earned
      FROM users u
      LEFT JOIN transactions t
        ON t.user_id = u.id
        AND ${where}
      WHERE u.is_banned = false
      GROUP BY u.id
    ) ranked
    WHERE id = $2
    `,
    [rewardTypes, req.userId]
  );

  return res.json({
    period,
    userRank: current.rows[0] ? Number(current.rows[0].position) : null,
    userEarned: current.rows[0] ? Number(current.rows[0].earned) : 0,
    leaders: result.rows.map((r, index) => ({
      position: index + 1,
      id: r.id,
      username: r.username,
      rank: r.rank,
      level: r.level,
      earned: Number(r.earned),
    })),
    prizes: [
      { position: 1, prize: 5 },
      { position: 2, prize: 3 },
      { position: 3, prize: 1 },
    ],
  });
});

module.exports = router;