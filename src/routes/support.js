const { Router } = require('express');
const pool = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = Router();

function fmt(t) {
  return {
    id: t.id,
    userId: t.user_id,
    username: t.username || null,
    subject: t.subject,
    message: t.message,
    status: t.status,
    adminReply: t.admin_reply || null,
    createdAt: new Date(t.created_at).toISOString(),
    updatedAt: new Date(t.updated_at).toISOString(),
  };
}

router.get('/', requireAuth, async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM support_tickets WHERE user_id = $1 ORDER BY created_at DESC',
    [req.userId]
  );
  res.json(result.rows.map(fmt));
});

router.post('/', requireAuth, async (req, res) => {
  const { subject, message } = req.body;
  if (!subject || !message) return res.status(400).json({ error: 'Subject and message are required' });
  const result = await pool.query(
    'INSERT INTO support_tickets (user_id, subject, message) VALUES ($1, $2, $3) RETURNING *',
    [req.userId, subject.trim(), message.trim()]
  );
  res.status(201).json(fmt(result.rows[0]));
});

router.get('/admin/all', requireAdmin, async (req, res) => {
  const status = req.query.status;
  const params = [];
  let query = 'SELECT s.*, u.username FROM support_tickets s LEFT JOIN users u ON s.user_id = u.id';
  if (status) { params.push(status); query += ' WHERE s.status = $1'; }
  query += ' ORDER BY s.created_at DESC';
  const result = await pool.query(query, params);
  res.json(result.rows.map(fmt));
});

router.patch('/admin/:id', requireAdmin, async (req, res) => {
  const { status, adminReply } = req.body;
  const result = await pool.query(
    `UPDATE support_tickets SET status = COALESCE($1, status), admin_reply = COALESCE($2, admin_reply), updated_at = NOW()
     WHERE id = $3 RETURNING *`,
    [status || null, adminReply || null, parseInt(req.params.id)]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Ticket not found' });
  const ticket = result.rows[0];
  await pool.query(
    `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'support')`,
    [ticket.user_id, 'Support ticket updated', `Your ticket "${ticket.subject}" was updated.`]
  );
  res.json(fmt(ticket));
});

module.exports = router;
