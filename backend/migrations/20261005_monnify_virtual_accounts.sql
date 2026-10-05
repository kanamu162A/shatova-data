CREATE TABLE IF NOT EXISTS virtual_accounts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  account_reference VARCHAR(100) NOT NULL UNIQUE,
  reservation_reference VARCHAR(150),
  account_name VARCHAR(200) NOT NULL,
  bank_code VARCHAR(30),
  bank_name VARCHAR(150),
  account_number VARCHAR(30) NOT NULL UNIQUE,
  currency VARCHAR(10) NOT NULL DEFAULT 'NGN',
  status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
  provider VARCHAR(30) NOT NULL DEFAULT 'MONNIFY',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_virtual_accounts_account_reference ON virtual_accounts(account_reference);
CREATE TABLE IF NOT EXISTS virtual_account_payments (
  id BIGSERIAL PRIMARY KEY,
  virtual_account_id BIGINT NOT NULL REFERENCES virtual_accounts(id) ON DELETE RESTRICT,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider_transaction_reference VARCHAR(150) NOT NULL UNIQUE,
  payment_reference VARCHAR(150),
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  currency VARCHAR(10) NOT NULL DEFAULT 'NGN',
  payer_name VARCHAR(200),
  payer_account_number VARCHAR(50),
  payer_bank_code VARCHAR(30),
  status VARCHAR(30) NOT NULL DEFAULT 'SUCCESS',
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_virtual_account_payments_user ON virtual_account_payments(user_id);
CREATE INDEX IF NOT EXISTS idx_virtual_account_payments_account ON virtual_account_payments(virtual_account_id);
