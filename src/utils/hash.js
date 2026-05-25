const { createHash } = require('crypto');

// New accounts use EarnyX salt. verifyPassword also supports older salts so existing
// users created before the rename can still log in.
const CURRENT_SALT = 'EarnyX-salt-v1';
const LEGACY_SALTS = ['Earnably-salt-v1', 'Earnova-salt-v1', 'Earnyx-salt-v1'];

function makeHash(password, salt) {
  return createHash('sha256').update(String(password) + salt).digest('hex');
}

function hashPassword(password) {
  return makeHash(password, CURRENT_SALT);
}

function verifyPassword(password, hash) {
  if (!hash) return false;

  const salts = [CURRENT_SALT, ...LEGACY_SALTS];
  return salts.some((salt) => makeHash(password, salt) === hash);
}

module.exports = { hashPassword, verifyPassword };
