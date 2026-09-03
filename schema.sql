-- ==============================================================================
-- THE MYSTERY CLICK - DATABASE SCHEMA (PostgreSQL / Supabase)
-- ==============================================================================
-- Bu SQL dosyasını Supabase Dashboard -> SQL Editor kısmına yapıştırıp "Run" 
-- butonuna basarak tüm tabloları ve indeksleri tek tıkla oluşturabilirsiniz.
-- ==============================================================================

-- 1. UUID Eklentisini Etkinleştir
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. KULLANICILAR TABLOSU (Users)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    nickname VARCHAR(50) NOT NULL,
    balance_clicks INT DEFAULT 0 CHECK (balance_clicks >= 0),
    total_clicks INT DEFAULT 0 CHECK (total_clicks >= 0),
    total_spent_usd NUMERIC(10, 2) DEFAULT 0.00,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_active TIMESTAMPTZ DEFAULT NOW()
);

-- E-posta aramaları için indeks
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- 3. ÖDEME / PAKET SATIN ALMA TABLOSU (Payments)
CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    clicks_purchased INT NOT NULL,
    amount_usd NUMERIC(10, 2) NOT NULL,
    payment_method VARCHAR(50) DEFAULT 'credit_card', -- 'credit_card', 'crypto_usdt'
    payment_status VARCHAR(20) DEFAULT 'success',     -- 'pending', 'success', 'failed'
    transaction_id VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);

-- 4. TIK GEÇMİŞİ & İSPAT KAYITLARI (Click Logs - Audit Trail)
-- 1'den 5.000.000'a kadar her bir tıklamanın kesin hukuki ispat kaydı
CREATE TABLE IF NOT EXISTS click_logs (
    id BIGSERIAL PRIMARY KEY,
    click_sequence_number BIGINT NOT NULL UNIQUE,  -- Tam sıra numarası (Örn: 5000000)
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    nickname VARCHAR(50) NOT NULL,
    email_masked VARCHAR(255) NOT NULL,
    ip_hash VARCHAR(64),                           -- Hile kontrolü için SHA256 IP hash
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Hızlı arama için indeksler
CREATE INDEX IF NOT EXISTS idx_click_sequence ON click_logs(click_sequence_number);
CREATE INDEX IF NOT EXISTS idx_click_logs_created ON click_logs(created_at DESC);

-- 5. OYUN METADATA & KAZANAN TABLOSU (Game State)
CREATE TABLE IF NOT EXISTS game_state (
    key VARCHAR(50) PRIMARY KEY,
    target_clicks BIGINT DEFAULT 5000000,
    current_clicks BIGINT DEFAULT 0,
    winner_user_id UUID REFERENCES users(id),
    winner_email VARCHAR(255),
    winner_nickname VARCHAR(50),
    winner_click_number BIGINT,
    won_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Başlangıç durumunu ekle (yoksa)
INSERT INTO game_state (key, target_clicks, current_clicks)
VALUES ('main_mystery_game', 5000000, 0)
ON CONFLICT (key) DO NOTHING;

-- 6. 5 MİLYONUNCU TIK SORGULAMA FONKSİYONU (Büyük Ödül Doğrulama)
-- İtiraz durumunda bu tek satırla kazanan teyit edilir:
-- SELECT * FROM click_logs WHERE click_sequence_number = 5000000;
