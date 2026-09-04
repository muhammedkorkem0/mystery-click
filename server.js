require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const app = express();
const server = http.createServer(app);

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

// Middleware for JSON & URL-encoded (OxaPay can send JSON or form-urlencoded)
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

// 1. User Login / Registration
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, nickname } = req.body;
    if (!email || !nickname) {
      return res.status(400).json({ error: 'Gmail ve Nickname zorunludur.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail.includes('@')) {
      return res.status(400).json({ error: 'Geçerli bir e-posta adresi giriniz.' });
    }

    const user = await db.getOrCreateUser(cleanEmail, nickname);
    const initData = await db.getInitialState();

    return res.json({
      user,
      winner: initData.winner,
      recentActivity: initData.recentActivity
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Giriş sırasında bir hata oluştu.' });
  }
});

// 2. OxaPay Crypto Checkout Creation
app.post('/api/clicks/create-checkout', async (req, res) => {
  try {
    const { email, packageAmount } = req.body;
    const amount = parseInt(packageAmount, 10);
    if (isNaN(amount) || amount < 10) {
      return res.status(400).json({ error: 'Minimum satın alma 10 click (1.00$) olmalıdır.' });
    }

    const cleanEmail = email ? email.trim().toLowerCase() : null;
    if (!cleanEmail) {
      return res.status(400).json({ error: 'Kullanıcı e-posta adresi eksik.' });
    }

    const merchantKey = process.env.OXAPAY_MERCHANT_KEY;
    const usdPrice = (amount * 0.10).toFixed(2); // 10 clicks = $1.00, 50 = $5.00, etc.

    // If OxaPay Merchant Key is configured, create live crypto invoice
    if (merchantKey && merchantKey.trim() !== '') {
      const orderId = `ORD_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
      
      const host = req.headers['x-forwarded-host'] || req.headers.host || 'mystery-click.vercel.app';
      const protocol = host.includes('localhost') ? 'http' : 'https';
      const callbackUrl = `${protocol}://${host}/api/payments/oxapay-webhook`;
      const returnUrl = `${protocol}://${host}/?payment=success`;

      const response = await fetch('https://api.oxapay.com/merchants/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          merchant: merchantKey,
          amount: parseFloat(usdPrice),
          currency: 'USD',
          orderId: orderId,
          email: cleanEmail,
          description: `${amount} Clicks Package for ${cleanEmail}`,
          callbackUrl: callbackUrl,
          returnUrl: returnUrl,
          lifeTime: 60 // 60 minutes payment window
        })
      });

      const json = await response.json();

      if (json.result === 100 && json.payLink) {
        return res.json({ success: true, checkoutUrl: json.payLink });
      } else {
        console.error('OxaPay request error:', json);
        return res.status(400).json({ error: json.message || 'Kripto ödeme sayfası oluşturulamadı.' });
      }
    }

    // FALLBACK / TEST MODE (If merchant key not filled yet)
    const result = await db.buyClicks(cleanEmail, amount);
    return res.json({
      success: true,
      mode: 'simulation',
      added: amount,
      newBalance: result.newBalance,
      message: 'OxaPay anahtarı henüz girilmediği için test modunda tık yüklendi.'
    });

  } catch (err) {
    console.error('OxaPay Checkout error:', err);
    return res.status(500).json({ error: err.message || 'Ödeme başlatılamadı.' });
  }
});

// 3. OxaPay Webhook Listener (Instant balance crediting on blockchain confirmation)
app.post('/api/payments/oxapay-webhook', async (req, res) => {
  try {
    const data = req.body;
    console.log('⚡ OxaPay Webhook geldi:', data);

    // OxaPay sends status === 'Paid' or 'Complete'
    if (data.status === 'Paid' || data.status === 'Complete') {
      const email = data.email;
      const amountUsd = parseFloat(data.amount) || 1.0;
      
      // Calculate clicks purchased from USD amount ($0.10 per click)
      const clicksToAdd = Math.round(amountUsd / 0.10);

      if (email && clicksToAdd >= 10) {
        console.log(`💰 Kripto ödemesi onaylandı: ${email} -> +${clicksToAdd} tık ($${amountUsd})`);
        await db.buyClicks(email, clicksToAdd);

        broadcast({
          type: 'PAYMENT_SUCCESS',
          email: email,
          clicksAdded: clicksToAdd
        });
      }
    }

    return res.send('OK');
  } catch (err) {
    console.error('OxaPay Webhook error:', err);
    return res.status(500).send('Webhook error');
  }
});

// 4. Process Atomic Click
app.post('/api/click', async (req, res) => {
  try {
    const { email, count = 1 } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    const result = await db.processClick(email, count, ip);

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
    return res.status(400).json({ error: err.message || 'Tıklama işlenemedi.' });
  }
});

// 5. Secure Admin Counter Maintenance
app.post('/api/admin/simulate-near-target', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!process.env.ADMIN_SECRET || adminKey !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Yetkisiz erişim.' });
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
