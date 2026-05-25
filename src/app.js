require('express-async-errors');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const offersRoutes = require('./routes/offers');
const tasksRoutes = require('./routes/tasks');
const withdrawalsRoutes = require('./routes/withdrawals');
const referralsRoutes = require('./routes/referrals');
const transactionsRoutes = require('./routes/transactions');
const adminRoutes = require('./routes/admin');
const webhookRoutes = require('./routes/webhooks');
const leaderboardRoutes = require('./routes/leaderboard');
const notificationsRoutes = require('./routes/notifications');
const supportRoutes = require('./routes/support');
const profileRoutes = require('./routes/profile');
const dailyRewardsRoutes = require('./routes/dailyRewards');
const postbackRoutes = require('./routes/postbacks');
const surveysRoutes = require('./routes/surveys');

const app = express();

app.set('trust proxy', 1);

// Force CORS headers before every middleware
app.use((req, res, next) => {
  const origin = req.headers.origin || '*';

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, PATCH, DELETE, OPTIONS'
  );
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  next();
});

app.use(
  cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Origin',
      'X-Requested-With',
      'Content-Type',
      'Accept',
      'Authorization',
    ],
    optionsSuccessStatus: 200,
  })
);

app.use(
  helmet({
    crossOriginResourcePolicy: false,
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: false,
  })
);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.RATE_LIMIT_MAX || 300),
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === 'OPTIONS',
  })
);

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    app: 'EarnyX API',
    health: '/api/health',
    cors: 'force-enabled',
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'EarnyX API',
    timestamp: new Date().toISOString(),
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/offers', offersRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/rewards', tasksRoutes);
app.use('/api/withdrawals', withdrawalsRoutes);
app.use('/api/referrals', referralsRoutes);
app.use('/api/transactions', transactionsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/leaderboard', leaderboardRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/daily-rewards', dailyRewardsRoutes);
app.use('/api/postbacks', postbackRoutes);
app.use('/api/offerwall/postback', postbackRoutes);
app.use('/api/surveys', surveysRoutes);

app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.originalUrl,
  });
});

app.use((err, req, res, next) => {
  console.error(err);

  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

module.exports = app;