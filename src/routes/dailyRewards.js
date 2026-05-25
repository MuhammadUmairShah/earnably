const { Router } = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = Router();

const rewards = {
  1: 0.02,
  2: 0.03,
  3: 0.05,
  4: 0.07,
  5: 0.10,
  6: 0.15,
  7: 0.25,
};

router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT last_daily_claim, daily_streak
       FROM users
       WHERE id = $1`,
      [req.userId]
    );

    const user = result.rows[0];

    if (!user) {
      return res.status(404).json({
        error: 'User not found',
      });
    }

    const now = new Date();

    let canClaim = true;
    let nextClaimIn = 0;

    if (user.last_daily_claim) {
      const lastClaim = new Date(user.last_daily_claim);
      const diff = now - lastClaim;
      const hours24 = 24 * 60 * 60 * 1000;

      if (diff < hours24) {
        canClaim = false;
        nextClaimIn = hours24 - diff;
      }
    }

    res.json({
      streak: Number(user.daily_streak || 0),
      canClaim,
      nextClaimIn,
      rewards,
    });
  } catch (error) {
    console.error('DAILY REWARD GET ERROR:', error);

    res.status(500).json({
      error: error.message || 'Failed to load daily reward',
    });
  }
});

router.post('/claim', requireAuth, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `SELECT balance,
              last_daily_claim,
              daily_streak,
              total_daily_claimed,
              total_earned
       FROM users
       WHERE id = $1
       FOR UPDATE`,
      [req.userId]
    );

    const user = result.rows[0];

    if (!user) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        error: 'User not found',
      });
    }

    const now = new Date();
    let streak = Number(user.daily_streak || 0);

    if (user.last_daily_claim) {
      const lastClaim = new Date(user.last_daily_claim);
      const diffHours = (now - lastClaim) / (1000 * 60 * 60);

      if (diffHours < 24) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          error: 'Daily reward already claimed',
        });
      }

      if (diffHours > 48) {
        streak = 0;
      }
    }

    streak += 1;

    if (streak > 7) {
      streak = 1;
    }

    const reward = Number(rewards[streak]);

    await client.query(
      `UPDATE users
       SET balance = COALESCE(balance, 0) + $1,
           total_earned = COALESCE(total_earned, 0) + $1,
           total_daily_claimed = COALESCE(total_daily_claimed, 0) + $1,
           daily_streak = $2,
           last_daily_claim = NOW(),
           updated_at = NOW()
       WHERE id = $3`,
      [reward, streak, req.userId]
    );

    await client.query(
      `INSERT INTO daily_rewards
       (user_id, reward, streak)
       VALUES ($1, $2, $3)`,
      [req.userId, reward, streak]
    );

    await client.query(
      `INSERT INTO transactions
       (user_id, type, amount, description)
       VALUES ($1, $2, $3, $4)`,
      [
        req.userId,
        'daily_reward',
        reward,
        `Daily reward claimed (Day ${streak})`,
      ]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      reward,
      streak,
      rewards,
      message: `Day ${streak} reward claimed`,
    });
  } catch (error) {
    await client.query('ROLLBACK');

    console.error('DAILY CLAIM ERROR:', error);

    res.status(500).json({
      error: error.message || 'Failed to claim reward',
    });
  } finally {
    client.release();
  }
});

module.exports = router;