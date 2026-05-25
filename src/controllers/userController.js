import bcrypt from "bcryptjs";
import pool from "../config/db.js";

const calculateProfileCompletion = (user) => {
  const fields = [
    user.full_name,
    user.username,
    user.email,
    user.avatar,
    user.country,
    user.bio,
  ];

  const completed = fields.filter((field) => field && String(field).trim() !== "").length;

  return Math.round((completed / fields.length) * 100);
};

const formatProfile = (user) => {
  const profileCompletion = calculateProfileCompletion(user);

  return {
    id: user.id,
    username: user.username || user.full_name || "EarnyX User",
    fullName: user.full_name || "",
    email: user.email,
    avatar: user.avatar || "",
    country: user.country || "",
    bio: user.bio || "",
    balance: Number(user.balance || 0),
    totalEarned: Number(user.total_earned || 0),
    referralCode: user.referral_code || "",
    rank: user.rank || "Member",
    isEmailVerified: Boolean(user.is_email_verified),
    withdrawalLocked: Boolean(user.withdrawal_locked),
    profileCompletion,
    createdAt: user.created_at,
  };
};

export const getProfile = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
        id,
        name AS full_name,
        email,
        username,
        avatar_url AS avatar,
        country,
        bio,
        balance,
        total_earned,
        referral_code,
        rank,
        is_email_verified,
        withdrawal_locked,
        created_at
       FROM users
       WHERE id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "User not found",
      });
    }

    res.json(formatProfile(result.rows[0]));
  } catch (error) {
    console.error("Get profile error:", error);
    res.status(500).json({
      error: "Failed to load profile",
    });
  }
};

export const updateProfile = async (req, res) => {
  try {
    const { fullName, username, avatar, country, bio } = req.body;

    if (bio && bio.length > 300) {
      return res.status(400).json({
        error: "Bio must be 300 characters or less",
      });
    }

    const result = await pool.query(
      `UPDATE users
       SET 
        name = COALESCE($1, name),
        username = COALESCE($2, username),
        avatar_url = COALESCE($3, avatar_url),
        country = COALESCE($4, country),
        bio = COALESCE($5, bio),
        updated_at = NOW()
       WHERE id = $6
       RETURNING
        id,
        name AS full_name,
        email,
        username,
        avatar_url AS avatar,
        country,
        bio,
        balance,
        total_earned,
        referral_code,
        rank,
        is_email_verified,
        withdrawal_locked,
        created_at`,
      [
        fullName?.trim() || null,
        username?.trim() || null,
        avatar?.trim() || null,
        country?.trim() || null,
        bio?.trim() || null,
        req.user.id,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "User not found",
      });
    }

    res.json({
      message: "Profile updated successfully",
      user: formatProfile(result.rows[0]),
    });
  } catch (error) {
    console.error("Update profile error:", error);

    if (error.code === "23505") {
      return res.status(400).json({
        error: "Username already taken",
      });
    }

    res.status(500).json({
      error: "Failed to update profile",
    });
  }
};

export const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        error: "Current password and new password are required",
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        error: "New password must be at least 6 characters",
      });
    }

    const user = await pool.query(
      "SELECT password FROM users WHERE id = $1",
      [req.user.id]
    );

    if (user.rows.length === 0) {
      return res.status(404).json({
        error: "User not found",
      });
    }

    const valid = await bcrypt.compare(
      currentPassword,
      user.rows[0].password
    );

    if (!valid) {
      return res.status(400).json({
        error: "Current password incorrect",
      });
    }

    const hashed = await bcrypt.hash(newPassword, 10);

    await pool.query(
      "UPDATE users SET password=$1, updated_at=NOW() WHERE id=$2",
      [hashed, req.user.id]
    );

    res.json({
      message: "Password updated successfully",
    });
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({
      error: "Failed to change password",
    });
  }
};