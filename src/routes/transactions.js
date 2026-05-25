const { Router } = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = Router();

router.get('/', requireAuth, async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  const { type } = req.query;

  let query = 'SELECT * FROM transactions WHERE user_id = $1';
  const params = [req.userId];

  if (type) { params.push(type); query += ` AND type = $${params.length}`; }

  query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);

  const result = await pool.query(query, params);
  res.json(result.rows.map(tx => ({
    id: tx.id, userId: tx.user_id, type: tx.type, amount: Number(tx.amount),
    description: tx.description, referenceId: tx.reference_id || null,
    referenceType: tx.reference_type || null, externalTransactionId: tx.external_transaction_id || null, createdAt: new Date(tx.created_at).toISOString(),
  })));
});

module.exports = router;
