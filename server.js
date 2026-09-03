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

// Middleware for JSON
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

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

// 0. Live Feed Poll Endpoint (Essential for Vercel fallback)
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

// 2. Lemon Squeezy Checkout Creation / Buy Clicks
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

    const apiKey = process.env.LEMON_SQUEEZY_API_KEY;
    const storeId = process.env.LEMON_SQUEEZY_STORE_ID;
    let variantId = process.env[`LEMON_VARIANT_${amount}_CLICKS`];

    if (apiKey && storeId && variantId) {
      const response = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
        method: 'POST',
        headers: {
          'Accept': 'application/vnd.api+json',
          'Content-Type': 'application/vnd.api+json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          data: {
            type: 'checkouts',
            attributes: {
              checkout_data: {
                email: cleanEmail,
                custom: {
                  email: cleanEmail,
                  package_amount: amount
                }
              }
            },
            relationships: {
              store: {
                data: {
                  type: 'stores',
                  id: storeId.toString()
                }
              },
              variant: {
                data: {
                  type: 'variants',
                  id: variantId.toString()
                }
              }
            }
          }
        })
      });

      const json = await response.json();
      if (!response.ok) {
        console.error('Lemon Squeezy API error:', json);
        return res.status(400).json({ error: 'Lemon Squeezy ödeme sayfası oluşturulamadı.' });
      }

      const checkoutUrl = json.data.attributes.url;
      return res.json({ success: true, checkoutUrl });
    }

    // FALLBACK / DEMO SIMULATION (If Lemon Squeezy API keys are not filled yet)
    const result = await db.buyClicks(cleanEmail, amount);
    return res.json({
      success: true,
      mode: 'simulation',
      added: amount,
      newBalance: result.newBalance,
      message: 'Lemon Squeezy anahtarları henüz girilmediği için test modunda tık bakiyesi yüklendi.'
    });

  } catch (err) {
    console.error('Checkout error:', err);
    return res.status(500).json({ error: err.message || 'Ödeme başlatılamadı.' });
  }
});

// 3. Lemon Squeezy Webhook Listener
app.post('/api/payments/lemon-webhook', async (req, res) => {
  try {
    const webhookSecret = process.env.LEMON_SQUEEZY_WEBHOOK_SECRET;
    const signature = req.headers['x-signature'];

    if (webhookSecret && signature) {
      const hmac = crypto.createHmac('sha256', webhookSecret);
      const digest = hmac.update(req.rawBody).digest('hex');
      if (signature !== digest) {
        return res.status(401).send('Geçersiz webhook imzası.');
      }
    }

    const event = req.body;
    const eventName = event.meta ? event.meta.event_name : null;

    if (eventName === 'order_created') {
      const customData = event.meta.custom_data || {};
      const userEmail = customData.email || event.data.attributes.user_email;
      const packageAmount = parseInt(customData.package_amount, 10) || 10;

      if (userEmail) {
        console.log(`💳 Lemon Squeezy ödemesi: ${userEmail} -> ${packageAmount} tık`);
        await db.buyClicks(userEmail, packageAmount);

        broadcast({
          type: 'PAYMENT_SUCCESS',
          email: userEmail,
          clicksAdded: packageAmount
        });
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).send('Webhook işleme hatası.');
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

// 5. Admin / Test Simulation
app.post('/api/admin/simulate-near-target', async (req, res) => {
  try {
    const { targetClicks = 5000000, currentClicks = 4999995 } = req.body;
    await db.simulateTarget(targetClicks, currentClicks);

    broadcast({
      type: 'ADMIN_RESET',
      message: 'Sayaç test amacıyla güncellendi.'
    });

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

// Start Server if local / standard container
if (!process.env.VERCEL) {
  (async () => {
    await db.init();
    server.listen(PORT, () => {
      console.log(`The Mystery Click server running on http://localhost:${PORT}`);
    });
  })();
}

module.exports = app;
