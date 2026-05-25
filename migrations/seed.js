require('dotenv').config();
const { Pool } = require('pg');
const { createHash } = require('crypto');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function hashPassword(password) {
  return createHash('sha256').update(password + 'EarnyX-salt-v1').digest('hex');
}

function generateReferralCode(username) {
  return createHash('md5').update(username + Date.now().toString()).digest('hex').slice(0, 8).toUpperCase();
}

async function seed() {
  console.log('Seeding database...');

  // Create admin
  await pool.query(
    `INSERT INTO users (username, email, password_hash, referral_code, role)
     VALUES ($1, $2, $3, $4, 'admin')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    ['admin', 'admin@EarnyX.com', hashPassword('admin123'), generateReferralCode('admin')]
  );

  // Create demo user
  await pool.query(
    `INSERT INTO users (username, email, password_hash, referral_code, balance, total_earned, level, rank)
     VALUES ($1, $2, $3, $4, 12.50, 47.25, 1, 'Bronze')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    ['demo', 'demo@EarnyX.com', hashPassword('demo123'), generateReferralCode('demo')]
  );

  // Seed offers
  const offers = [
    ['Complete a 10-minute survey', 'Share your opinions and earn cash rewards instantly.', 'cpx', 'survey', 2.50, 'easy', '10 min'],
    ['Download & Play Mobile Game', 'Install this top-rated game and reach level 5 to earn.', 'adgem', 'app_download', 1.75, 'easy', '15 min'],
    ['Watch 5 Video Ads', 'Watch short video clips and earn for each completion.', 'lootably', 'video', 0.50, 'easy', '5 min'],
    ['Tech Survey - 20 Minutes', 'Share your technology usage habits for research.', 'cpx', 'survey', 4.00, 'medium', '20 min'],
    ['Install Shopping App', 'Download and make your first purchase to earn big.', 'adgem', 'app_download', 3.25, 'medium', '30 min'],
    ['Play Casino Game (Demo)', 'Try the demo version of this popular casino game.', 'lootably', 'game', 1.50, 'easy', '10 min'],
    ['Health & Lifestyle Survey', 'Answer questions about your daily health routines.', 'cpx', 'survey', 3.75, 'medium', '15 min'],
    ['Finance App Registration', 'Register for this financial tracking app for free.', 'adgem', 'app_download', 5.00, 'hard', '45 min'],
  ];

  for (const [title, description, provider, category, reward, difficulty, estimatedTime] of offers) {
    await pool.query(
      `INSERT INTO offers (title, description, provider, category, reward, difficulty, estimated_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING`,
      [title, description, provider, category, reward, difficulty, estimatedTime]
    );
  }

  // Seed tasks
  const tasks = [
    ['Follow on Twitter', 'Follow @EarnyX on Twitter and earn instantly.', 'social', 0.25, false],
    ['Join Telegram Channel', 'Join our official Telegram channel for updates.', 'social', 0.25, false],
    ['Rate the App', 'Leave a 5-star review on the app store.', 'review', 0.50, false],
    ['Refer a Friend', 'Share your referral link and get credit when they join.', 'referral', 1.00, true],
    ['Daily Check-in Bonus', 'Log in every day for your daily bonus streak.', 'daily', 0.10, true],
    ['Complete Your Profile', 'Fill in your profile information completely.', 'profile', 0.50, false],
    ['Watch Tutorial Video', 'Watch how to maximize your earnings on EarnyX.', 'educational', 0.15, false],
    ['First Withdrawal', 'Complete your first successful withdrawal to earn a bonus.', 'milestone', 2.00, false],
  ];

  for (const [title, description, category, reward, isRepeatable] of tasks) {
    await pool.query(
      `INSERT INTO tasks (title, description, category, reward, is_repeatable)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [title, description, category, reward, isRepeatable]
    );
  }

  console.log('Seed complete!');
  console.log('  Admin: admin@EarnyX.com / admin123');
  console.log('  Demo:  demo@EarnyX.com  / demo123');
  await pool.end();
}

seed().catch(err => { console.error(err); process.exit(1); });
