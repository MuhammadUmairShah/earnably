const { createHash } = require('crypto');

function generateReferralCode(username) {
  return createHash('md5')
    .update(username + Date.now().toString())
    .digest('hex')
    .slice(0, 8)
    .toUpperCase();
}

function computeLevel(totalEarned) {
  const earned = Number(totalEarned);
  if (earned >= 1000) return { level: 4, rank: 'Platinum' };
  if (earned >= 500)  return { level: 3, rank: 'Gold' };
  if (earned >= 100)  return { level: 2, rank: 'Silver' };
  return { level: 1, rank: 'Bronze' };
}

const REFERRAL_COMMISSION_RATE = 0.05;

module.exports = { generateReferralCode, computeLevel, REFERRAL_COMMISSION_RATE };
