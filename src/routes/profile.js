const { Router } = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = Router();

const PROFILE_BONUS = 0.25;

function profileCompletion(user) {
  const checks = [
    Boolean(user.username),
    Boolean(user.email),
    Boolean(user.full_name),
    Boolean(user.country),
    Boolean(user.bio),
    Boolean(user.avatar),
    Boolean(user.is_email_verified),
  ];

  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}

function makeUsername(user) {
  return (
    user.username ||
    user.full_name ||
    String(user.email || '').split('@')[0] ||
    'EarnyX User'
  );
}

function formatProfile(user) {
  return {
    id: user.id,
    username: makeUsername(user),
    email: user.email,
    fullName: user.full_name || '',
    avatar: user.avatar || '',
    country: user.country || '',
    bio: user.bio || '',
    balance: Number(user.balance || 0),
    totalEarned: Number(user.total_earned || 0),
    referralCode: user.referral_code || '',
    role: user.role || 'user',
    rank: user.rank || 'Member',
    isEmailVerified: Boolean(user.is_email_verified),
    withdrawalLocked: Boolean(user.withdrawal_locked),
    profileCompleted: Boolean(user.profile_completed),
    profileBonusClaimed: Boolean(user.profile_bonus_claimed),
    profileCompletion: profileCompletion(user),
    createdAt: user.created_at ? new Date(user.created_at).toISOString() : null,
  };
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE id = $1',
      [req.userId]
    );

    const user = result.rows[0];

    if (!user) {
      return res.status(404).json({
        error: 'User not found',
      });
    }

    return res.json(formatProfile(user));
  } catch (error) {
    console.error('PROFILE GET ERROR:', error);

    return res.status(500).json({
      error: error.message || 'Failed to load profile',
    });
  }
});

router.patch('/', requireAuth, async (req, res) => {
  try {
    const username = String(req.body.username || '').trim().slice(0, 40);
    const fullName = String(req.body.fullName || '').trim().slice(0, 80);
    const avatar = String(req.body.avatar || '').trim().slice(0, 500);
    const country = String(req.body.country || '').trim().slice(0, 80);
    const bio = String(req.body.bio || '').trim().slice(0, 300);

    const currentUserResult = await pool.query(
      'SELECT username, full_name, email FROM users WHERE id = $1',
      [req.userId]
    );

    const currentUser = currentUserResult.rows[0];

    if (!currentUser) {
      return res.status(404).json({
        error: 'User not found',
      });
    }

    const safeUsername =
      username ||
      currentUser.username ||
      fullName ||
      currentUser.full_name ||
      String(currentUser.email || '').split('@')[0] ||
      'EarnyX User';

    const safeFullName =
      fullName ||
      currentUser.full_name ||
      safeUsername;

    const result = await pool.query(
      `UPDATE users
       SET username = $1,
           full_name = $2,
           avatar = $3,
           country = $4,
           bio = $5,
           updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [
        safeUsername,
        safeFullName,
        avatar || null,
        country || null,
        bio || null,
        req.userId,
      ]
    );

    if (!result.rows[0]) {
      return res.status(404).json({
        error: 'User not found',
      });
    }

    return res.json({
      message: 'Profile updated successfully',
      user: formatProfile(result.rows[0]),
    });
  } catch (error) {
    console.error('PROFILE UPDATE ERROR:', error);

    return res.status(500).json({
      error: error.message || 'Failed to update profile',
    });
  }
});

router.post('/claim-bonus', requireAuth, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const userResult = await client.query(
      `SELECT *
       FROM users
       WHERE id = $1
       FOR UPDATE`,
      [req.userId]
    );

    const user = userResult.rows[0];

    if (!user) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        error: 'User not found',
      });
    }

    if (user.profile_bonus_claimed) {
      await client.query('ROLLBACK');

      return res.status(400).json({
        error: 'Profile bonus already claimed',
      });
    }

    const completion = profileCompletion(user);

    if (completion < 100) {
      await client.query('ROLLBACK');

      return res.status(400).json({
        error: 'Complete your profile 100% first',
        profileCompletion: completion,
      });
    }

    const updatedUser = await client.query(
      `UPDATE users
       SET balance = COALESCE(balance, 0) + $1,
           total_earned = COALESCE(total_earned, 0) + $1,
           profile_completed = true,
           profile_bonus_claimed = true,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [PROFILE_BONUS, req.userId]
    );

    await client.query(
      `INSERT INTO transactions
       (user_id, type, amount, description, reference_type)
       VALUES ($1, 'profile_bonus', $2, $3, 'profile')`,
      [
        req.userId,
        PROFILE_BONUS,
        'Profile completion bonus',
      ]
    );

    try {
      await client.query(
        `INSERT INTO notifications
         (user_id, title, message, type)
         VALUES ($1, $2, $3, $4)`,
        [
          req.userId,
          'Profile Bonus Claimed',
          `You received $${PROFILE_BONUS} for completing your profile.`,
          'reward',
        ]
      );
    } catch (notifyError) {
      console.error('Profile bonus notification skipped:', notifyError.message);
    }

    await client.query('COMMIT');

    return res.json({
      success: true,
      reward: PROFILE_BONUS,
      message: 'Profile bonus claimed successfully',
      user: formatProfile(updatedUser.rows[0]),
    });
  } catch (error) {
    await client.query('ROLLBACK');

    console.error('PROFILE BONUS ERROR:', error);

    return res.status(500).json({
      error: error.message || 'Failed to claim profile bonus',
    });
  } finally {
    client.release();
  }
});

module.exports = router;