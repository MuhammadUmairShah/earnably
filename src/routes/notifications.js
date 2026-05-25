const { Router } = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = Router();

router.get('/', requireAuth, async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30',
    [req.userId]
  );
  res.json(result.rows.map(n => ({
    id: n.id,
    title: n.title,
    message: n.message,
    type: n.type,
    isRead: n.is_read,
    createdAt: new Date(n.created_at).toISOString(),
  })));
});

router.patch('/:id/read', requireAuth, async (req, res) => {
  const result = await pool.query(
    'UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2 RETURNING *',
    [parseInt(req.params.id), req.userId]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Notification not found' });
  res.json({ ok: true });
});

module.exports = router;
