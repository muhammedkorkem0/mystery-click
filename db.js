require('dotenv').config();
const { Pool } = require('pg');
const Redis = require('ioredis');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data.json');

class DatabaseManager {
  constructor() {
    this.pgPool = null;
    this.redisClient = null;
    this.usePostgres = false;
    this.useRedis = false;

    // In-memory cache for live feed
    this.recentActivityCache = [];

    // Local fallback state
    this.localState = {
      targetClicks: 5000000,
      currentClicks: 0,
      winner: null,
      users: {},
      recentActivity: []
    };
  }

  async init() {
    // 1. Check Redis / Upstash
    if (process.env.REDIS_URL && process.env.REDIS_URL.trim() !== '') {
      try {
        this.redisClient = new Redis(process.env.REDIS_URL, {
          tls: process.env.REDIS_URL.startsWith('rediss://') ? {} : undefined,
          maxRetriesPerRequest: 3
        });
        await this.redisClient.ping();
        this.useRedis = true;
        console.log('✅ Redis / Upstash bağlantısı aktif.');
      } catch (err) {
        console.warn('⚠️ Redis bağlantısı başarısız:', err.message);
        this.useRedis = false;
      }
    } else {
      console.log('ℹ️ REDIS_URL tanımlanmadı, PostgreSQL atomik motoru devrede.');
    }

    // 2. Check PostgreSQL / Supabase
    if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== '') {
      try {
        this.pgPool = new Pool({
          connectionString: process.env.DATABASE_URL,
          ssl: { rejectUnauthorized: false },
          connectionTimeoutMillis: 5000,
          idleTimeoutMillis: 10000,
          max: 10
        });
        const client = await this.pgPool.connect();
        console.log('✅ Supabase PostgreSQL veritabanına başarıyla bağlandı!');
        
        // Initial sync of game_state
        const res = await client.query("SELECT * FROM game_state WHERE key = 'main_mystery_game';");
        if (res.rows.length === 0) {
          await client.query("INSERT INTO game_state (key, target_clicks, current_clicks) VALUES ('main_mystery_game', 5000000, 0);");
        }
        client.release();
        this.usePostgres = true;
      } catch (err) {
        console.warn('⚠️ PostgreSQL bağlantısı başarısız, yerel JSON kullanılıyor:', err.message);
        this.usePostgres = false;
      }
    }

    // Local fallback data loading
    if (!this.usePostgres && fs.existsSync(DATA_FILE)) {
      try {
        const raw = fs.readFileSync(DATA_FILE, 'utf8');
        this.localState = { ...this.localState, ...JSON.parse(raw) };
      } catch (e) {
        console.error('Local data load error:', e);
      }
    }
  }

  saveLocal() {
    if (!this.usePostgres) {
      try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(this.localState, null, 2));
      } catch (e) {
        console.error('Local data save error:', e);
      }
    }
  }

  // 1. Get or Create User
  async getOrCreateUser(email, nickname) {
    const cleanEmail = email.trim().toLowerCase();
    const cleanNick = nickname.trim().slice(0, 20);

    if (this.usePostgres) {
      const query = `
        INSERT INTO users (email, nickname, balance_clicks, total_clicks)
        VALUES ($1, $2, 0, 0)
        ON CONFLICT (email) DO UPDATE SET
          nickname = EXCLUDED.nickname,
          last_active = NOW()
        RETURNING id, email, nickname, balance_clicks as balance, total_clicks as "totalClicks", created_at;
      `;
      const res = await this.pgPool.query(query, [cleanEmail, cleanNick]);
      return res.rows[0];
    }

    // Local Fallback
    if (!this.localState.users[cleanEmail]) {
      this.localState.users[cleanEmail] = {
        email: cleanEmail,
        nickname: cleanNick,
        balance: 0,
        totalClicks: 0,
        createdAt: Date.now()
      };
    } else {
      this.localState.users[cleanEmail].nickname = cleanNick;
    }
    this.saveLocal();
    return this.localState.users[cleanEmail];
  }

  // 2. Buy Clicks (Purchase with Replay Protection)
  async buyClicks(email, amount, paymentId = null, paymentMethod = 'crypto_nowpayments') {
    const cleanEmail = email.trim().toLowerCase();
    const usdAmount = (amount * 0.10).toFixed(2);

    if (this.usePostgres) {
      const client = await this.pgPool.connect();
      try {
        await client.query('BEGIN');

        // Replay Protection: check if transaction_id has already been processed
        if (paymentId) {
          const checkRes = await client.query(`
            SELECT id FROM payments 
            WHERE transaction_id = $1 AND payment_status = 'success';
          `, [String(paymentId)]);

          if (checkRes.rows.length > 0) {
            console.log(`⚠️ Tekrarlanan ödeme engellendi (Replay Protection): ${paymentId}`);
            await client.query('ROLLBACK');
            return { success: true, alreadyProcessed: true };
          }
        }
        
        const userRes = await client.query(`
          UPDATE users 
          SET balance_clicks = balance_clicks + $1,
              total_spent_usd = total_spent_usd + $2
          WHERE email = $3
          RETURNING id, email, nickname, balance_clicks as balance;
        `, [amount, usdAmount, cleanEmail]);

        if (userRes.rows.length === 0) throw new Error('User not found.');

        const user = userRes.rows[0];

        await client.query(`
          INSERT INTO payments (user_id, email, clicks_purchased, amount_usd, payment_method, payment_status, transaction_id)
          VALUES ($1, $2, $3, $4, $5, 'success', $6);
        `, [user.id, cleanEmail, amount, usdAmount, paymentMethod, paymentId ? String(paymentId) : null]);

        await client.query('COMMIT');
        return { success: true, added: amount, newBalance: user.balance };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    // Local Fallback
    if (!this.localState.processedPayments) {
      this.localState.processedPayments = [];
    }
    if (paymentId && this.localState.processedPayments.includes(String(paymentId))) {
      console.log(`⚠️ Yerel tekrarlanan ödeme engellendi: ${paymentId}`);
      return { success: true, alreadyProcessed: true };
    }

    const user = this.localState.users[cleanEmail];
    if (!user) throw new Error('User not found.');
    user.balance += amount;
    if (paymentId) {
      this.localState.processedPayments.push(String(paymentId));
    }
    this.saveLocal();
    return { success: true, added: amount, newBalance: user.balance };
  }

  // 3. Process Atomic Click (Using Supabase Postgres / Redis)
  async processClick(email, count = 1, ipHash = null) {
    const cleanEmail = email.trim().toLowerCase();
    const clickCount = Math.min(Math.max(parseInt(count, 10) || 1, 1), 50);

    if (this.usePostgres) {
      const client = await this.pgPool.connect();
      try {
        await client.query('BEGIN');

        // 1. Check & Deduct user balance
        const userRes = await client.query(`
          UPDATE users
          SET balance_clicks = balance_clicks - $1,
              total_clicks = total_clicks + $1,
              last_active = NOW()
          WHERE email = $2 AND balance_clicks >= $1
          RETURNING id, nickname, email, balance_clicks as balance, total_clicks as "totalClicks";
        `, [clickCount, cleanEmail]);

        if (userRes.rows.length === 0) {
          await client.query('ROLLBACK');
          throw new Error('Insufficient balance! Please purchase clicks.');
        }

        const user = userRes.rows[0];

        // 2. Atomic Global Counter Increment
        let newGlobalCount = 0;
        let prevGlobalCount = 0;
        let targetClicks = 5000000;

        if (this.useRedis) {
          newGlobalCount = await this.redisClient.incrby('global_mystery_counter', clickCount);
          prevGlobalCount = newGlobalCount - clickCount;
        } else {
          // Atomic SQL Row Lock Increment
          const gameRes = await client.query(`
            UPDATE game_state
            SET current_clicks = current_clicks + $1,
                updated_at = NOW()
            WHERE key = 'main_mystery_game'
            RETURNING target_clicks, current_clicks, winner_email;
          `, [clickCount]);

          targetClicks = parseInt(gameRes.rows[0].target_clicks, 10);
          newGlobalCount = parseInt(gameRes.rows[0].current_clicks, 10);
          prevGlobalCount = newGlobalCount - clickCount;

          if (gameRes.rows[0].winner_email) {
            await client.query('ROLLBACK');
            throw new Error('The 5,000,000 grand prize has been won and the winner has been determined!');
          }
        }

        let hitWinner = false;
        let winnerInfo = null;

        if (prevGlobalCount < targetClicks && newGlobalCount >= targetClicks) {
          hitWinner = true;
          winnerInfo = {
            email: user.email,
            nickname: user.nickname,
            clickNumber: targetClicks,
            wonAt: Date.now()
          };

          await client.query(`
            UPDATE game_state
            SET winner_user_id = $1,
                winner_email = $2,
                winner_nickname = $3,
                winner_click_number = $4,
                won_at = NOW()
            WHERE key = 'main_mystery_game';
          `, [user.id, user.email, user.nickname, targetClicks]);
        }

        // 3. Insert audit log into click_logs
        const maskedEmail = user.email.replace(/(.{2})(.*)(@.*)/, '$1***$3');
        const insertLogSql = `
          INSERT INTO click_logs (click_sequence_number, user_id, nickname, email_masked, ip_hash)
          VALUES ($1, $2, $3, $4, $5);
        `;

        for (let i = 1; i <= clickCount; i++) {
          const seq = prevGlobalCount + i;
          await client.query(insertLogSql, [seq, user.id, user.nickname, maskedEmail, ipHash || 'web-client']);
        }

        await client.query('COMMIT');

        const activityItem = {
          nickname: user.nickname,
          emailMasked: maskedEmail,
          clicks: clickCount,
          time: Date.now()
        };

        this.recentActivityCache.unshift(activityItem);
        if (this.recentActivityCache.length > 50) this.recentActivityCache.pop();

        return {
          success: true,
          clicksUsed: clickCount,
          remainingBalance: user.balance,
          totalUserClicks: user.totalClicks,
          hitWinner,
          winner: winnerInfo,
          activityItem
        };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    // Local Fallback
    const user = this.localState.users[cleanEmail];
    if (!user) throw new Error('User not found.');
    if (user.balance < clickCount) throw new Error('Insufficient balance! Please purchase clicks.');
    if (this.localState.winner) throw new Error('The 5,000,000 grand prize has already been won!');

    user.balance -= clickCount;
    user.totalClicks += clickCount;

    const prevCount = this.localState.currentClicks;
    this.localState.currentClicks += clickCount;
    let hitWinner = false;

    if (prevCount < this.localState.targetClicks && this.localState.currentClicks >= this.localState.targetClicks) {
      hitWinner = true;
      this.localState.winner = {
        email: user.email,
        nickname: user.nickname,
        clickNumber: this.localState.targetClicks,
        wonAt: Date.now()
      };
    }

    const maskedEmail = user.email.replace(/(.{2})(.*)(@.*)/, '$1***$3');
    const activityItem = {
      nickname: user.nickname,
      emailMasked: maskedEmail,
      clicks: clickCount,
      time: Date.now()
    };

    this.localState.recentActivity.unshift(activityItem);
    if (this.localState.recentActivity.length > 50) this.localState.recentActivity.pop();

    this.saveLocal();

    return {
      success: true,
      clicksUsed: clickCount,
      remainingBalance: user.balance,
      totalUserClicks: user.totalClicks,
      hitWinner,
      winner: this.localState.winner,
      activityItem
    };
  }

  // Get Initial State (Winner & Recent Activity)
  async getInitialState() {
    if (this.usePostgres) {
      try {
        const gameRes = await this.pgPool.query("SELECT * FROM game_state WHERE key = 'main_mystery_game';");
        const row = gameRes.rows[0];
        let winner = null;
        if (row && row.winner_email) {
          winner = {
            email: row.winner_email,
            nickname: row.winner_nickname,
            clickNumber: row.winner_click_number,
            wonAt: row.won_at
          };
        }
        return {
          winner,
          recentActivity: this.recentActivityCache.slice(0, 30)
        };
      } catch (err) {
        console.error('getInitialState error:', err);
      }
    }

    return {
      winner: this.localState.winner,
      recentActivity: this.localState.recentActivity.slice(0, 30)
    };
  }

  // Demo Simulation Helper
  async simulateTarget(targetClicks, currentClicks) {
    if (this.usePostgres) {
      await this.pgPool.query(`
        UPDATE game_state 
        SET target_clicks = $1, 
            current_clicks = $2, 
            winner_user_id = NULL, 
            winner_email = NULL, 
            winner_nickname = NULL, 
            winner_click_number = NULL, 
            won_at = NULL 
        WHERE key = 'main_mystery_game';
      `, [targetClicks, currentClicks]);
    }
    if (this.useRedis) {
      await this.redisClient.set('global_mystery_counter', currentClicks);
    }
    this.localState.targetClicks = targetClicks;
    this.localState.currentClicks = currentClicks;
    this.localState.winner = null;
    this.saveLocal();
  }
}

module.exports = new DatabaseManager();
