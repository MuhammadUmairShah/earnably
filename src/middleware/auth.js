const { verifyToken } = require('../utils/jwt');
const pool = require('../db');

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Unauthorized',
      });
    }

    const token = authHeader.slice(7);
    const payload = verifyToken(token);

    if (!payload) {
      return res.status(401).json({
        error: 'Invalid token',
      });
    }

    const { rows } = await pool.query(
      'SELECT id, role, is_banned FROM users WHERE id = $1',
      [payload.userId]
    );

    const user = rows[0];

    if (!user || user.is_banned) {
      return res.status(401).json({
        error: 'Account not found or banned',
      });
    }

    req.userId = user.id;
    req.userRole = user.role;

    next();
  } catch (error) {
    console.error('AUTH MIDDLEWARE ERROR:', error);

    return res.status(401).json({
      error: 'Authentication failed',
    });
  }
}

async function requireAdmin(req, res, next) {
  return requireAuth(req, res, () => {
    if (String(req.userRole || '').toLowerCase() !== 'admin') {
      return res.status(403).json({
        error: 'Admin access required',
      });
    }

    next();
  });
}

module.exports = {
  requireAuth,
  requireAdmin,
};