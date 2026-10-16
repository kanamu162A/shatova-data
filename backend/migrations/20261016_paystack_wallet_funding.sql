-- Shatova Paystack funding foundation.
-- Apply manually to a non-production database first; do not run automatically at boot.
CREATE TABLE IF NOT EXISTS paystack_payment_intents (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  reference VARCHAR(100) NOT NULL UNIQUE,
  amount_kobo BIGINT NOT NULL CHECK (amount_kobo > 0),
  currency CHAR(3) NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'success', 'failed')),
  access_code TEXT,
  checkout_url TEXT,
  provider_transaction_id BIGINT UNIQUE,
  provider_customer_code TEXT,
  paid_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_paystack_intents_user_created
  ON paystack_payment_intents (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_paystack_intents_status_created
  ON paystack_payment_intents (status, created_at);

CREATE TABLE IF NOT EXISTS paystack_webhook_events (
  id BIGSERIAL PRIMARY KEY,
  event_key VARCHAR(180) NOT NULL UNIQUE,
  event_type VARCHAR(100) NOT NULL,
  reference VARCHAR(100),
  processed_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_paystack_events_reference
  ON paystack_webhook_events (reference);
