const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'EarnyX-secret-key';
const EXPIRES_IN = '30d';

function createToken(userId, role) {
  return jwt.sign({ userId, role }, SECRET, { expiresIn: EXPIRES_IN });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}

module.exports = { createToken, verifyToken };
