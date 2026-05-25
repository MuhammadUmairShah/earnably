-- EarnyX reward/postback hardening and provider tables

CREATE TABLE IF NOT EXISTS offerwall_postbacks (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(50) NOT NULL,
  transaction_id VARCHAR(255) UNIQUE NOT NULL,
  reward NUMERIC(12,2) DEFAULT 0,
  status VARCHAR(50) DEFAULT 'completed',
  raw_data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_offerwall_postbacks_user_id ON offerwall_postbacks(user_id);
CREATE INDEX IF NOT EXISTS idx_offerwall_postbacks_provider ON offerwall_postbacks(provider);
CREATE INDEX IF NOT EXISTS idx_offerwall_postbacks_transaction_id ON offerwall_postbacks(transaction_id);

CREATE TABLE IF NOT EXISTS offerwall_providers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  wall_url TEXT,
  api_key TEXT,
  postback_secret TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS survey_providers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  wall_url TEXT,
  api_key TEXT,
  postback_secret TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transactions_user_type ON transactions(user_id, type);
CREATE INDEX IF NOT EXISTS idx_transactions_external_transaction_id ON transactions(external_transaction_id);
