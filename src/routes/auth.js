const { Router } = require('express');
const crypto = require('crypto');

const pool = require('../db');
const { hashPassword, verifyPassword } = require('../utils/hash');
const { createToken } = require('../utils/jwt');
const { generateReferralCode } = require('../utils/referral');
const { requireAuth } = require('../middleware/auth');
const sendEmail = require('../utils/sendEmail');

const router = Router();

function formatUser(u) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    balance: Number(u.balance || 0),
    totalEarned: Number(u.total_earned || 0),
    level: u.level,
    rank: u.rank,
    referralCode: u.referral_code,
    role: u.role,
    isBanned: u.is_banned,
    isEmailVerified: u.is_email_verified,
    avatar: u.avatar || '',
    fullName: u.full_name || '',
    country: u.country || '',
    bio: u.bio || '',
    lastDailyReward: u.last_daily_reward
      ? new Date(u.last_daily_reward).toISOString()
      : null,
    createdAt: u.created_at ? new Date(u.created_at).toISOString() : null,
  };
}

function cleanUrl(url) {
  return String(url || '').trim().replace(/\/$/, '');
}

function getBackendUrl() {
  return cleanUrl(
    process.env.BACKEND_URL || 'https://earnably-api-production.up.railway.app'
  );
}

function getFrontendUrl() {
  const frontendUrl = process.env.FRONTEND_URL || 'https://earnably-e0162.web.app';

  return cleanUrl(frontendUrl.split(',')[0]);
}

function sendEmailInBackground(to, subject, html, label) {
  setTimeout(() => {
    sendEmail(to, subject, html)
      .then(() => console.log(`${label} email sent to:`, to))
      .catch((error) => console.error(`${label} email failed:`, error.message));
  }, 100);
}

function verificationEmailHtml(username, verifyLink) {
  return `
    <div style="font-family: Arial, sans-serif; background:#0f0c1c; padding:30px;">
      <div style="max-width:600px; margin:auto; background:#17122b; border-radius:18px; padding:30px; color:white;">
        <h1 style="color:#a855f7;">Welcome to EarnyX 🚀</h1>
        <p>Hi ${username},</p>
        <p>Please verify your email address to activate your EarnyX account.</p>
        <a href="${verifyLink}" style="display:inline-block; margin-top:20px; padding:14px 22px; background:#7c3aed; color:white; text-decoration:none; border-radius:12px; font-weight:bold;">
          Verify Email
        </a>
        <p style="margin-top:25px; color:#aaa; font-size:13px;">
          If the button does not work, copy this link:<br/>${verifyLink}
        </p>
      </div>
    </div>
  `;
}

router.post('/register', async (req, res) => {
  const { username, email, password, referralCode } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email, and password are required' });
  }

  const cleanUsername = String(username).trim();
  const cleanEmail = String(email).trim().toLowerCase();
  const cleanPassword = String(password);

  if (cleanUsername.length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  }

  if (cleanPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [cleanEmail]);

  if (existing.rows.length > 0) {
    return res.status(400).json({ error: 'Email already registered' });
  }

  const existingUsername = await pool.query(
    'SELECT id FROM users WHERE username = $1',
    [cleanUsername]
  );

  if (existingUsername.rows.length > 0) {
    return res.status(400).json({ error: 'Username already taken' });
  }

  let referredById = null;

  if (referralCode) {
    const referrer = await pool.query(
      'SELECT id FROM users WHERE referral_code = $1',
      [String(referralCode).trim()]
    );

    if (referrer.rows.length > 0) referredById = referrer.rows[0].id;
  }

  const passwordHash = hashPassword(cleanPassword);
  const newReferralCode = generateReferralCode(cleanUsername);
  const emailVerificationToken = crypto.randomBytes(32).toString('hex');

  const result = await pool.query(
    `INSERT INTO users
     (username, email, password_hash, referral_code, referred_by, email_verification_token, is_email_verified)
     VALUES ($1, $2, $3, $4, $5, $6, false)
     RETURNING *`,
    [
      cleanUsername,
      cleanEmail,
      passwordHash,
      newReferralCode,
      referredById,
      emailVerificationToken,
    ]
  );

  const user = result.rows[0];
  const verifyLink = `${getBackendUrl()}/api/auth/verify-email?token=${emailVerificationToken}`;

  sendEmailInBackground(
    cleanEmail,
    'Verify your EarnyX account',
    verificationEmailHtml(cleanUsername, verifyLink),
    'Verification'
  );

  return res.status(201).json({
    message: 'Account created. Please verify your email before login.',
    email: user.email,
  });
});

router.get('/verify-email', async (req, res) => {
  const { token } = req.query;

  if (!token) return res.status(400).send('Verification token is missing');

  const result = await pool.query(
    `UPDATE users
     SET is_email_verified = true,
         email_verification_token = NULL
     WHERE email_verification_token = $1
     RETURNING *`,
    [token]
  );

  if (result.rows.length === 0) {
    return res.status(400).send('Invalid or expired verification link');
  }

  return res.send(`
    <div style="font-family: Arial, sans-serif; background:#0f0c1c; min-height:100vh; display:flex; align-items:center; justify-content:center; color:white;">
      <div style="background:#17122b; padding:35px; border-radius:20px; text-align:center; max-width:480px;">
        <h1 style="color:#22c55e;">Email Verified ✅</h1>
        <p>Your EarnyX account email has been verified successfully.</p>
        <a href="${getFrontendUrl()}/login" style="display:inline-block; margin-top:20px; padding:12px 20px; background:#7c3aed; color:white; text-decoration:none; border-radius:12px;">
          Go to Login
        </a>
      </div>
    </div>
  `);
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const cleanEmail = String(email).trim().toLowerCase();
  const cleanPassword = String(password);

  const result = await pool.query('SELECT * FROM users WHERE email = $1', [cleanEmail]);
  const user = result.rows[0];

  const passwordMatch = user ? verifyPassword(cleanPassword, user.password_hash) : false;

  console.log('LOGIN DEBUG:', {
    email: cleanEmail,
    userFound: Boolean(user),
    passwordMatch,
    isEmailVerified: user?.is_email_verified,
    isBanned: user?.is_banned,
  });

  if (!user || !passwordMatch) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  if (user.is_banned) {
    return res.status(401).json({ error: 'Account is banned' });
  }

  if (!user.is_email_verified) {
    return res.status(401).json({ error: 'Please verify your email first' });
  }

  const token = createToken(user.id, user.role);

  return res.json({
    token,
    user: formatUser(user),
  });
});

router.post('/resend-verification', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const cleanEmail = String(email).trim().toLowerCase();
  const result = await pool.query('SELECT * FROM users WHERE email = $1', [cleanEmail]);
  const user = result.rows[0];

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (user.is_email_verified) {
    return res.json({ message: 'Email is already verified' });
  }

  const emailVerificationToken = crypto.randomBytes(32).toString('hex');

  await pool.query(
    'UPDATE users SET email_verification_token = $1 WHERE id = $2',
    [emailVerificationToken, user.id]
  );

  const verifyLink = `${getBackendUrl()}/api/auth/verify-email?token=${emailVerificationToken}`;

  sendEmailInBackground(
    user.email,
    'Verify your EarnyX account',
    verificationEmailHtml(user.username, verifyLink),
    'Resend verification'
  );

  return res.json({ message: 'Verification email sent again' });
});

router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;

  if (!email) return res.status(400).json({ error: 'Email is required' });

  const cleanEmail = String(email).trim().toLowerCase();
  const result = await pool.query('SELECT * FROM users WHERE email = $1', [cleanEmail]);
  const user = result.rows[0];

  if (!user) {
    return res.json({ message: 'If this email exists, a reset link has been sent.' });
  }

  const resetToken = crypto.randomBytes(32).toString('hex');
  const resetExpires = new Date(Date.now() + 60 * 60 * 1000);

  await pool.query(
    'UPDATE users SET password_reset_token = $1, password_reset_expires = $2 WHERE id = $3',
    [resetToken, resetExpires, user.id]
  );

  const resetLink = `${getFrontendUrl()}/reset-password?token=${resetToken}`;

  sendEmailInBackground(
    user.email,
    'Reset your EarnyX password',
    `
      <div style="font-family: Arial, sans-serif; background:#0f0c1c; padding:30px;">
        <div style="max-width:600px; margin:auto; background:#17122b; border-radius:18px; padding:30px; color:white;">
          <h1 style="color:#a855f7;">Reset your password</h1>
          <p>Hi ${user.username},</p>
          <p>Click the button below to reset your EarnyX password. This link expires in 1 hour.</p>
          <a href="${resetLink}" style="display:inline-block; margin-top:20px; padding:14px 22px; background:#7c3aed; color:white; text-decoration:none; border-radius:12px; font-weight:bold;">Reset Password</a>
        </div>
      </div>
    `,
    'Password reset'
  );

  return res.json({ message: 'If this email exists, a reset link has been sent.' });
});

router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;

  if (!token || !password) {
    return res.status(400).json({ error: 'Token and password are required' });
  }

  const cleanPassword = String(password);

  if (cleanPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const result = await pool.query(
    `SELECT * FROM users
     WHERE password_reset_token = $1
       AND password_reset_expires > NOW()`,
    [token]
  );

  const user = result.rows[0];

  if (!user) {
    return res.status(400).json({ error: 'Invalid or expired reset link' });
  }

  await pool.query(
    `UPDATE users
     SET password_hash = $1,
         password_reset_token = NULL,
         password_reset_expires = NULL
     WHERE id = $2`,
    [hashPassword(cleanPassword), user.id]
  );

  return res.json({ message: 'Password reset successfully. You can login now.' });
});

router.get('/me', async (req, res) => {
  try {
    await requireAuth(req, res, async () => {
      const result = await pool.query(
        'SELECT * FROM users WHERE id = $1',
        [req.userId]
      );

      const user = result.rows[0];

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      return res.json(formatUser(user));
    });
  } catch (error) {
    console.error('ME ROUTE ERROR:', error);
    return res.status(500).json({ error: 'Failed to load user' });
  }
});

module.exports = router;