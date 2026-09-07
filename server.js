require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('./db');

const app = express();
const server = http.createServer(app);

// Trust first proxy for accurate client IP identification on Vercel/proxies
app.set('trust proxy', 1);

// --- SECURITY & RATE LIMITING CONFIGURATION ---
// 1. Click Rate Limiter (Max 8 requests per second per IP)
const clickLimiter = rateLimit({
  windowMs: 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'You are clicking too fast! Bot protection active. Please slow down.' }
});

// 2. Auth Login Rate Limiter (Max 15 attempts per minute per IP)
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign in attempts. Please try again in 1 minute.' }
});

// 3. Checkout Rate Limiter (Max 12 invoice creations per minute per IP)
const checkoutLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Payment request limit exceeded. Please wait a moment.' }
});

// --- SESSION TOKEN HELPERS (HMAC-SHA256 Signed Tokens) ---
const AUTH_SECRET = process.env.AUTH_SECRET || process.env.JWT_SECRET || 'mystery_click_auth_secret_2026_super_secure_key_987';

function generateAuthToken(email, nickname) {
  const payload = {
    email: email.trim().toLowerCase(),
    nickname: (nickname || '').trim(),
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000 // 30 days
  };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyAuthToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  try {
    const expectedSig = crypto.createHmac('sha256', AUTH_SECRET).update(data).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
      return null;
    }
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Date.now()) {
      return null; // Expired
    }
    return payload;
  } catch (err) {
    return null;
  }
}

// --- NOWPAYMENTS IPN SIGNATURE VERIFIER ---
function verifyNowpaymentsSignature(req, ipnSecret) {
  const signature = req.headers['x-nowpayments-sig'];
  if (!signature || !ipnSecret) return false;
  try {
    const sortedKeys = Object.keys(req.body).sort();
    const sortedObj = {};
    for (const key of sortedKeys) {
      sortedObj[key] = req.body[key];
    }
    const payloadStr = JSON.stringify(sortedObj);
    const hmac = crypto.createHmac('sha512', ipnSecret.trim()).update(payloadStr).digest('hex');
    return hmac.toLowerCase() === signature.toLowerCase();
  } catch (err) {
    return false;
  }
}

// In non-serverless environments, WebSocket server is initialized
let wss = null;
if (!process.env.VERCEL) {
  wss = new WebSocket.Server({ server });
}

const PORT = process.env.PORT || 3000;

// Lazy Database Initialization for Vercel Serverless
let isDbReady = false;
app.use(async (req, res, next) => {
  if (!isDbReady) {
    await db.init();
    isDbReady = true;
  }
  next();
});

// Middleware for JSON & URL-encoded
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Broadcast message to all connected clients via WebSocket
function broadcast(data) {
  if (!wss) return;
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// REST APIs

// 0. Live Feed Poll Endpoint (For Vercel support)
app.get('/api/feed', async (req, res) => {
  try {
    const initState = await db.getInitialState();
    return res.json({
      winner: initState.winner,
      recentActivity: initState.recentActivity
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// 1. User Login / Registration (Rate Limited & Signed Token)
app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, nickname, ref } = req.body;
    if (!email || !nickname) {
      return res.status(400).json({ error: 'Email and Nickname are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail.includes('@')) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const user = await db.getOrCreateUser(cleanEmail, nickname, ref);
    const initData = await db.getInitialState();
    const token = generateAuthToken(cleanEmail, user.nickname || nickname);

    return res.json({
      user: {
        ...user,
        token
      },
      winner: initData.winner,
      recentActivity: initData.recentActivity
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'An error occurred during sign in.' });
  }
});

// 2. NOWPayments Crypto Invoice Creation (Rate Limited)
app.post('/api/clicks/create-checkout', checkoutLimiter, async (req, res) => {
  try {
    const { email, packageAmount } = req.body;
    const amount = parseInt(packageAmount, 10);
    if (isNaN(amount) || amount < 10) {
      return res.status(400).json({ error: 'Minimum purchase is 10 clicks ($1.00).' });
    }

    const cleanEmail = email ? email.trim().toLowerCase() : null;
    if (!cleanEmail) {
      return res.status(400).json({ error: 'User email address is missing.' });
    }

    const apiKey = process.env.NOWPAYMENTS_API_KEY || '6CW3604-M4Q4K3S-GN7N6QM-EY3BEK9';
    const usdPrice = (amount * 0.10).toFixed(2); // 10 clicks = $1.00

    // If NOWPayments API Key is configured, create live crypto invoice
    if (apiKey && apiKey.trim() !== '') {
      const host = req.headers['x-forwarded-host'] || req.headers.host || 'mystery-click.vercel.app';
      const protocol = host.includes('localhost') ? 'http' : 'https';
      
      const orderId = `MC_${encodeURIComponent(cleanEmail)}_${amount}_${Date.now()}`;
      const callbackUrl = `https://mystery-click.vercel.app/api/payments/nowpayments-webhook`;
      const successUrl = `${protocol}://${host}/?payment=success`;
      const cancelUrl = `${protocol}://${host}/`;

      const response = await fetch('https://api.nowpayments.io/v1/invoice', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey.trim(),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          price_amount: parseFloat(usdPrice),
          price_currency: 'usd',
          order_id: orderId,
          order_description: `${amount} Clicks Pack (Mystery Click - ${cleanEmail})`,
          ipn_callback_url: callbackUrl,
          success_url: successUrl,
          cancel_url: cancelUrl
        })
      });

      const json = await response.json();

      if (json.invoice_url) {
        return res.json({ success: true, checkoutUrl: json.invoice_url });
      } else {
        console.error('NOWPayments invoice error:', json);
        return res.status(400).json({ error: json.message || 'Failed to create crypto payment invoice.' });
      }
    }

    // FALLBACK / TEST MODE (If API key not set yet)
    const result = await db.buyClicks(cleanEmail, amount);
    return res.json({
      success: true,
      mode: 'simulation',
      added: amount,
      newBalance: result.newBalance,
      message: 'Test clicks loaded.'
    });

  } catch (err) {
    console.error('NOWPayments Checkout error:', err);
    return res.status(500).json({ error: err.message || 'Could not initiate payment.' });
  }
});

// 3. NOWPayments Webhook Listener (IPN - Secure 2-Layer Verification & Replay Protection)
app.post('/api/payments/nowpayments-webhook', async (req, res) => {
  try {
    const data = req.body;
    console.log('⚡ NOWPayments IPN received:', data);

    const paymentId = data.payment_id;
    const orderId = data.order_id || '';
    const status = data.payment_status;
    const apiKey = process.env.NOWPAYMENTS_API_KEY || '6CW3604-M4Q4K3S-GN7N6QM-EY3BEK9';
    let isVerified = false;

    // Layer 1: Verify directly with NOWPayments official API (Bulletproof verification)
    if (paymentId && apiKey) {
      try {
        const verifyRes = await fetch(`https://api.nowpayments.io/v1/payment/${paymentId}`, {
          headers: { 'x-api-key': apiKey.trim() }
        });
        if (verifyRes.ok) {
          const verifiedData = await verifyRes.json();
          console.log(`🔒 NOWPayments Official Verification [${paymentId}]:`, verifiedData.payment_status);
          if (verifiedData.payment_status === 'finished' || verifiedData.payment_status === 'confirmed') {
            isVerified = true;
            data.payment_status = verifiedData.payment_status;
            data.price_amount = verifiedData.price_amount || data.price_amount;
          } else {
            console.log(`ℹ️ Payment not yet completed (${verifiedData.payment_status}), waiting.`);
            return res.status(200).send('Payment pending');
          }
        } else {
          console.warn(`⚠️ NOWPayments API query failed (${verifyRes.status}).`);
        }
      } catch (verifyErr) {
        console.error('NOWPayments API verification error:', verifyErr.message);
      }
    }

    // Layer 2: Signature verification fallback (if IPN_SECRET is configured)
    if (!isVerified && process.env.NOWPAYMENTS_IPN_SECRET) {
      if (verifyNowpaymentsSignature(req, process.env.NOWPAYMENTS_IPN_SECRET)) {
        if (status === 'finished' || status === 'confirmed') {
          isVerified = true;
        }
      }
    }

    // If both verifications failed, reject fake/unverified webhook
    if (!isVerified) {
      console.warn('⛔ Fake or unverified webhook rejected!');
      return res.status(400).json({ error: 'Unverified webhook request.' });
    }

    // Process payment if verified
    let userEmail = null;
    let packageAmount = 0;

    // Extract from orderId: MC_user%40gmail.com_10_timestamp
    if (orderId.startsWith('MC_')) {
      const parts = orderId.split('_');
      if (parts.length >= 4) {
        userEmail = decodeURIComponent(parts[1]);
        packageAmount = parseInt(parts[2], 10);
      }
    }

    // Fallback calculation from price_amount ($0.10 per click)
    if (!packageAmount && data.price_amount) {
      packageAmount = Math.round(parseFloat(data.price_amount) / 0.10);
    }

    if (userEmail && packageAmount >= 10) {
      const creditResult = await db.buyClicks(userEmail, packageAmount, paymentId, 'crypto_nowpayments');
      if (creditResult.alreadyProcessed) {
        console.log(`ℹ️ Payment #${paymentId} already processed.`);
      } else {
        console.log(`💰 Payment verified: ${userEmail} -> +${packageAmount} clicks`);
        broadcast({
          type: 'PAYMENT_SUCCESS',
          email: userEmail,
          clicksAdded: packageAmount
        });
      }
    }

    return res.status(200).send('OK');
  } catch (err) {
    console.error('NOWPayments Webhook error:', err);
    return res.status(500).send('Webhook error');
  }
});

// 4. Process Atomic Click (Rate Limited & Session Token Protected)
app.post('/api/click', clickLimiter, async (req, res) => {
  try {
    const { email, count = 1 } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email address is required.' });
    }

    const cleanEmail = email.trim().toLowerCase();

    // Authentication: Extract and verify token from Bearer header or body
    const authHeader = req.headers['authorization'];
    const token = (authHeader && authHeader.startsWith('Bearer '))
      ? authHeader.slice(7)
      : req.body.token;

    if (!token) {
      return res.status(401).json({ error: 'Unauthorized: Session token missing. Please sign in again.' });
    }

    const verifiedUser = verifyAuthToken(token);
    if (!verifiedUser || verifiedUser.email !== cleanEmail) {
      return res.status(403).json({ error: 'Unauthorized: Session expired or mismatched email address.' });
    }

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const result = await db.processClick(cleanEmail, count, ip);

    // Broadcast via WS (if running)
    broadcast({
      type: 'CLICK_ACTIVITY',
      activity: result.activityItem
    });

    if (result.hitWinner) {
      broadcast({
        type: 'WINNER_ANNOUNCEMENT',
        winner: result.winner
      });
    }

    return res.json({
      success: true,
      clicksUsed: result.clicksUsed,
      remainingBalance: result.remainingBalance,
      totalUserClicks: result.totalUserClicks,
      winner: result.winner
    });
  } catch (err) {
    console.error('Click error:', err);
    return res.status(400).json({ error: err.message || 'Failed to process click.' });
  }
});

// 5. Secure Admin Counter Maintenance
app.post('/api/admin/simulate-near-target', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!process.env.ADMIN_SECRET || adminKey !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Unauthorized access.' });
  }
  try {
    const { targetClicks = 5000000, currentClicks = 0 } = req.body;
    await db.simulateTarget(targetClicks, currentClicks);
    return res.json({ success: true, targetClicks, currentClicks });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// WebSocket Connection (Non-serverless mode)
if (wss) {
  wss.on('connection', async (ws) => {
    try {
      const initState = await db.getInitialState();
      ws.send(JSON.stringify({
        type: 'INIT_STATE',
        winner: initState.winner,
        recentActivity: initState.recentActivity
      }));
    } catch (err) {
      console.error('WS init error:', err);
    }
  });
}

// Start Server if local
if (!process.env.VERCEL) {
  (async () => {
    await db.init();
    server.listen(PORT, () => {
      console.log(`The Mystery Click server running on http://localhost:${PORT}`);
    });
  })();
}

module.exports = app;
