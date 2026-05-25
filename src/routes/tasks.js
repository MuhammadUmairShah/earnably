const { Router } = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { computeLevel, REFERRAL_COMMISSION_RATE } = require('../utils/referral');

const router = Router();

router.get('/', requireAuth, async (req, res) => {
  const { category } = req.query;
  let query = 'SELECT * FROM tasks WHERE is_active = true';
  const params = [];
  if (category) { params.push(category); query += ` AND category = $${params.length}`; }
  query += ' ORDER BY created_at DESC';

  const tasks = await pool.query(query, params);
  const completions = await pool.query(
    'SELECT task_id FROM task_completions WHERE user_id = $1', [req.userId]
  );
  const completedIds = new Set(completions.rows.map(c => c.task_id));

  res.json(tasks.rows.map(t => ({
    id: t.id, title: t.title, description: t.description, category: t.category,
    reward: Number(t.reward), imageUrl: t.image_url || null, isActive: t.is_active,
    isCompleted: completedIds.has(t.id),
    expiresAt: t.expires_at ? new Date(t.expires_at).toISOString() : null,
    createdAt: new Date(t.created_at).toISOString(),
  })));
});

router.post('/:id/complete', requireAuth, async (req, res) => {
  const taskId = parseInt(req.params.id);
  const task = (await pool.query('SELECT * FROM tasks WHERE id = $1', [taskId])).rows[0];
  if (!task || !task.is_active) return res.status(404).json({ error: 'Task not found or inactive' });

  if (!task.is_repeatable) {
    const existing = await pool.query(
      'SELECT id FROM task_completions WHERE task_id = $1 AND user_id = $2',
      [taskId, req.userId]
    );
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Task already completed' });
  }

  await pool.query(
    'INSERT INTO task_completions (task_id, user_id) VALUES ($1, $2)',
    [taskId, req.userId]
  );

  const reward = Number(task.reward);
  await pool.query(
    `UPDATE users SET balance = balance + $1, total_earned = total_earned + $1 WHERE id = $2`,
    [reward, req.userId]
  );

  const updatedUser = (await pool.query('SELECT * FROM users WHERE id = $1', [req.userId])).rows[0];
  const { level, rank } = computeLevel(Number(updatedUser.total_earned));
  await pool.query('UPDATE users SET level = $1, rank = $2 WHERE id = $3', [level, rank, req.userId]);

  if (updatedUser.referred_by) {
    const commission = reward * REFERRAL_COMMISSION_RATE;
    await pool.query(
      `UPDATE users SET balance = balance + $1, total_earned = total_earned + $1 WHERE id = $2`,
      [commission, updatedUser.referred_by]
    );
    await pool.query(
      `INSERT INTO transactions (user_id, type, amount, description, reference_id, reference_type)
       VALUES ($1, 'referral_bonus', $2, $3, $4, 'referral')`,
      [updatedUser.referred_by, commission, `Referral commission from ${updatedUser.username}`, req.userId]
    );
  }

  const tx = await pool.query(
    `INSERT INTO transactions (user_id, type, amount, description, reference_id, reference_type)
     VALUES ($1, 'task_completion', $2, $3, $4, 'task') RETURNING *`,
    [req.userId, reward, `Completed task: ${task.title}`, taskId]
  );

  const t = tx.rows[0];
  res.json({
    id: t.id, userId: t.user_id, type: t.type, amount: Number(t.amount),
    description: t.description, referenceId: t.reference_id || null,
    referenceType: t.reference_type || null, createdAt: new Date(t.created_at).toISOString(),
  });
});

router.post('/daily', requireAuth, async (req, res) => {
  const user = (await pool.query('SELECT * FROM users WHERE id = $1', [req.userId])).rows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (user.last_daily_reward && new Date(user.last_daily_reward) >= startOfDay) {
    return res.status(400).json({ error: 'Daily reward already claimed today' });
  }

  const yesterday = new Date(startOfDay);
  yesterday.setDate(yesterday.getDate() - 1);
  const previousClaim = user.last_daily_reward ? new Date(user.last_daily_reward) : null;
  const continuedStreak = previousClaim && previousClaim >= yesterday && previousClaim < startOfDay;
  const nextStreak = continuedStreak ? Number(user.daily_streak || 0) + 1 : 1;
  const streakBonus = Math.min(nextStreak, 7) * 0.01;
  const DAILY_REWARD = Number((0.05 + streakBonus).toFixed(2));

  await pool.query(
    `UPDATE users
     SET balance = balance + $1,
         total_earned = total_earned + $1,
         last_daily_reward = $2,
         daily_streak = $3,
         best_daily_streak = GREATEST(best_daily_streak, $3)
     WHERE id = $4`,
    [DAILY_REWARD, now, nextStreak, req.userId]
  );

  await pool.query(
    `INSERT INTO notifications (user_id, title, message, type)
     VALUES ($1, 'Daily streak claimed', $2, 'reward')`,
    [req.userId, `You claimed day ${nextStreak} and earned $${DAILY_REWARD.toFixed(2)}.`]
  );

  const tx = await pool.query(
    `INSERT INTO transactions (user_id, type, amount, description, reference_type)
     VALUES ($1, 'daily_reward', $2, 'Daily login reward', 'daily') RETURNING *`,
    [req.userId, DAILY_REWARD]
  );

  const t = tx.rows[0];
  res.json({
    id: t.id, userId: t.user_id, type: t.type, amount: Number(t.amount),
    description: t.description, referenceId: null, streak: nextStreak, referenceType: t.reference_type || null,
    createdAt: new Date(t.created_at).toISOString(),
  });
});

module.exports = router;
