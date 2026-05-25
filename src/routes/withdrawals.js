const { Router } = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const sendEmail = require('../utils/sendEmail');

const router = Router();

const MIN_WITHDRAWAL = Number(process.env.MIN_WITHDRAWAL || 5);

function sendEmailInBackground(to, subject, html) {
  setImmediate(() => {
    sendEmail(to, subject, html).catch((error) => {
      console.error('Withdrawal email failed:', error.message);
    });
  });
}

function formatMethod(m) {
  return {
    id: m.id,
    method: m.method,
    accountDetails: m.account_details,
    isDefault: Boolean(m.is_default),
    createdAt: m.created_at ? new Date(m.created_at).toISOString() : null,
  };
}

function formatWithdrawal(w) {
  return {
    id: w.id,
    userId: w.user_id,
    amount: Number(w.amount),
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

async function getCurrentUser(userId) {
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  return result.rows[0];
}

router.get('/', requireAuth, async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC',
    [req.userId]
  );

  return res.json(result.rows.map(formatWithdrawal));
});

router.get('/methods', requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM withdrawal_methods
     WHERE user_id = $1
     ORDER BY is_default DESC, created_at DESC`,
    [req.userId]
  );

  return res.json(result.rows.map(formatMethod));
});

router.post('/methods', requireAuth, async (req, res) => {
  const method = String(req.body.method || '').trim();
  const accountDetails = String(req.body.accountDetails || '').trim();

  if (!method || !accountDetails) {
    return res.status(400).json({
      error: 'Method and account details are required',
    });
  }

  const user = await getCurrentUser(req.userId);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (!user.is_email_verified) {
    return res.status(403).json({
      error: 'Please verify your email before adding a withdrawal method',
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const count = await client.query(
      'SELECT COUNT(*) FROM withdrawal_methods WHERE user_id = $1',
      [req.userId]
    );

    const isDefault = Number(count.rows[0].count || 0) === 0;

    if (isDefault) {
      await client.query(
        'UPDATE withdrawal_methods SET is_default = false WHERE user_id = $1',
        [req.userId]
      );
    }

    const result = await client.query(
      `INSERT INTO withdrawal_methods
       (user_id, method, account_details, is_default)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.userId, method, accountDetails, isDefault]
    );

    await client.query('COMMIT');

    return res.status(201).json(formatMethod(result.rows[0]));
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create withdrawal method error:', error);
    return res.status(500).json({ error: 'Failed to save withdrawal method' });
  } finally {
    client.release();
  }
});

router.patch('/methods/:id/default', requireAuth, async (req, res) => {
  const id = Number(req.params.id);

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const exists = await client.query(
      'SELECT id FROM withdrawal_methods WHERE id = $1 AND user_id = $2',
      [id, req.userId]
    );

    if (!exists.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Withdrawal method not found' });
    }

    await client.query(
      'UPDATE withdrawal_methods SET is_default = false WHERE user_id = $1',
      [req.userId]
    );

    const result = await client.query(
      `UPDATE withdrawal_methods
       SET is_default = true, updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [id, req.userId]
    );

    await client.query('COMMIT');

    return res.json(formatMethod(result.rows[0]));
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Default method error:', error);
    return res.status(500).json({ error: 'Failed to set default method' });
  } finally {
    client.release();
  }
});

router.delete('/methods/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);

  await pool.query(
    'DELETE FROM withdrawal_methods WHERE id = $1 AND user_id = $2',
    [id, req.userId]
  );

  return res.json({ message: 'Withdrawal method deleted' });
});

router.post('/', requireAuth, async (req, res) => {
  const { amount, method, accountDetails, withdrawalMethodId } = req.body;
  const amountValue = Number(amount);

  if (!amountValue || Number.isNaN(amountValue) || amountValue <= 0) {
    return res.status(400).json({ error: 'Invalid withdrawal amount' });
  }

  if (amountValue < MIN_WITHDRAWAL) {
    return res.status(400).json({
      error: `Minimum withdrawal is $${MIN_WITHDRAWAL}`,
    });
  }

  const user = await getCurrentUser(req.userId);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (!user.is_email_verified) {
    return res.status(403).json({
      error: 'Please verify your email before requesting a withdrawal',
    });
  }

  if (user.withdrawal_locked) {
    return res.status(403).json({
      error: 'Withdrawals are temporarily locked for security review',
    });
  }

  const pending = await pool.query(
    `SELECT id FROM withdrawals
     WHERE user_id = $1 AND status = 'pending'
     LIMIT 1`,
    [req.userId]
  );

  if (pending.rows.length > 0) {
    return res.status(400).json({
      error: 'You already have a pending withdrawal',
    });
  }

  if (Number(user.balance) < amountValue) {
    return res.status(400).json({ error: 'Insufficient balance' });
  }

  let finalMethod = method;
  let finalDetails = accountDetails;
  let methodId = withdrawalMethodId || null;

  if (withdrawalMethodId) {
    const savedMethod = await pool.query(
      'SELECT * FROM withdrawal_methods WHERE id = $1 AND user_id = $2',
      [withdrawalMethodId, req.userId]
    );

    if (!savedMethod.rows[0]) {
      return res.status(404).json({
        error: 'Saved withdrawal method not found',
      });
    }

    finalMethod = savedMethod.rows[0].method;
    finalDetails = savedMethod.rows[0].account_details;
  }

  finalMethod = String(finalMethod || '').trim();
  finalDetails = String(finalDetails || '').trim();

  if (!finalMethod || !finalDetails) {
    return res.status(400).json({
      error: 'Withdrawal method details are required',
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const balanceCheck = await client.query(
      'SELECT balance FROM users WHERE id = $1 FOR UPDATE',
      [req.userId]
    );

    const currentBalance = Number(balanceCheck.rows[0]?.balance || 0);

    if (currentBalance < amountValue) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    await client.query(
      'UPDATE users SET balance = balance - $1, updated_at = NOW() WHERE id = $2',
      [amountValue, req.userId]
    );

    const withdrawal = (
      await client.query(
        `INSERT INTO withdrawals
         (user_id, amount, method, account_details, withdrawal_method_id, email_confirmed, security_note)
         VALUES ($1, $2, $3, $4, $5, true, $6)
         RETURNING *`,
        [
          req.userId,
          amountValue,
          finalMethod,
          finalDetails,
          methodId,
          'Email verified account. Pending admin review.',
        ]
      )
    ).rows[0];

    await client.query(
      `INSERT INTO transactions
       (user_id, type, amount, description, reference_id, reference_type)
       VALUES ($1, 'withdrawal', $2, $3, $4, 'withdrawal')`,
      [req.userId, -amountValue, `Withdrawal via ${finalMethod}`, withdrawal.id]
    );

    await client.query(
      `INSERT INTO notifications
       (user_id, title, message, type)
       VALUES ($1, 'Withdrawal requested', $2, 'withdrawal')`,
      [
        req.userId,
        `Your ${finalMethod} withdrawal for $${amountValue.toFixed(
          2
        )} is pending admin review.`,
      ]
    );

    await client.query('COMMIT');

    sendEmailInBackground(
      user.email,
      'EarnyX Withdrawal Request Received',
      `
        <div style="font-family:Arial;padding:30px;background:#0f0c1c;color:white;">
          <div style="max-width:600px;margin:auto;background:#17122b;padding:30px;border-radius:20px;">
            <h1 style="color:#a855f7;">Withdrawal Requested</h1>
            <p>Hello ${user.username || 'EarnyX user'},</p>
            <p>Your withdrawal request was received successfully and is pending admin review.</p>
            <p><strong>Amount:</strong> $${amountValue.toFixed(2)}</p>
            <p><strong>Method:</strong> ${finalMethod}</p>
          </div>
        </div>
      `
    );

    return res.status(201).json(formatWithdrawal(withdrawal));
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Withdrawal create error:', error);
    return res.status(500).json({ error: 'Failed to create withdrawal' });
  } finally {
    client.release();
  }
});

module.exports = router;