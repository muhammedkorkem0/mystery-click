require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
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

// 2. NOWPayments Crypto Invoice Creation
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
          order_description: `${amount} Tık Paketi (Mystery Click - ${cleanEmail})`,
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
        return res.status(400).json({ error: json.message || 'Kripto ödeme faturası oluşturulamadı.' });
      }
    }

    // FALLBACK / TEST MODE (If API key not set yet)
    const result = await db.buyClicks(cleanEmail, amount);
    return res.json({
      success: true,
      mode: 'simulation',
      added: amount,
      newBalance: result.newBalance,
      message: 'Test modunda tık yüklendi.'
    });

  } catch (err) {
    console.error('NOWPayments Checkout error:', err);
    return res.status(500).json({ error: err.message || 'Ödeme başlatılamadı.' });
  }
});

// 3. NOWPayments Webhook Listener (IPN - Instant balance crediting on payment)
app.post('/api/payments/nowpayments-webhook', async (req, res) => {
  try {
    const data = req.body;
    console.log('⚡ NOWPayments IPN bildirimi geldi:', data);

    // NOWPayments sends payment_status: 'finished', 'confirmed', 'sending', etc.
    const status = data.payment_status;
    if (status === 'finished' || status === 'confirmed') {
      const orderId = data.order_id || '';
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
        console.log(`💰 Kripto ödemesi başarıyla tamamlandı: ${userEmail} -> +${packageAmount} tık`);
        await db.buyClicks(userEmail, packageAmount);

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
