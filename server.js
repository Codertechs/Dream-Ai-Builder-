require('dotenv').config();
const express = require('express');
const cors = require('cors');
const basicAuth = require('express-basic-auth');
const rateLimit = require('express-rate-limit');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 4000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5500';

const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

app.use(cors({ origin: true }));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
// Stripe webhooks need the raw body, so this route is registered
// BEFORE the global express.json() body parser below.
app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(400).send('Stripe not configured');
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    db.prepare(`
      UPDATE orders SET status = 'paid', customer_email = ?
      WHERE stripe_session_id = ?
    `).run(session.customer_details?.email || session.customer_email, session.id);
  }

  res.json({ received: true });
});

app.use(express.json());

// ---------- Public API ----------

app.get('/api/plans', (req, res) => {
  const plans = db.prepare('SELECT * FROM plans WHERE active = 1').all();
  res.json(plans);
});

app.post('/api/checkout', async (req, res) => {
  const { plan: planId } = req.body;
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);

  if (!plan) return res.status(404).json({ error: 'Unknown plan' });
  if (plan.price_cents === 0) return res.status(400).json({ error: 'Free plan needs no checkout' });
  if (!stripe) return res.status(500).json({ error: 'Stripe is not configured on this server yet' });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: plan.stripe_price_id
        ? [{ price: plan.stripe_price_id, quantity: 1 }]
        : [{
            price_data: {
              currency: 'usd',
              product_data: { name: `AI Dream Builder — ${plan.name}` },
              unit_amount: plan.price_cents,
              recurring: { interval: plan.interval }
            },
            quantity: 1
          }],
      success_url: `${FRONTEND_URL}/?checkout=success`,
      cancel_url: `${FRONTEND_URL}/?checkout=cancelled`
    });

    db.prepare(`
      INSERT INTO orders (stripe_session_id, plan_id, amount_cents, status)
      VALUES (?, ?, ?, 'pending')
    `).run(session.id, plan.id, plan.price_cents);

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create checkout session' });
  }
});

// The hero "build it free" box uses YOUR API key on the server, shared across
// every visitor — so it's rate-limited per IP to keep costs predictable.
const generateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,                   // 5 free builds per IP per hour
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many free builds from this device — try again in a bit, or add your own API key.' }
});

// Minimal AI generation proxy — wire in the model of your choice.
// Keeps the API key server-side instead of exposing it in the frontend.
app.post('/api/generate', generateLimiter, async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });
  if (prompt.length > 4000) return res.status(400).json({ error: 'Prompt is too long for a free build' });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set on server' });
  }
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1200, // capped to keep free-tier token spend predictable
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: data.error?.message || 'Generation failed' });
    }
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Generation failed' });
  }
});

// ---------- Push a build to GitHub ----------
// The visitor pastes their own GitHub personal access token (repo scope).
// It's used only for this one request and is never written to disk or the DB.
const githubLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many GitHub pushes from this device — try again in a bit.' }
});

app.post('/api/github/push', githubLimiter, async (req, res) => {
  const { token, repoName, code, description } = req.body;

  if (!token) return res.status(400).json({ error: 'GitHub token is required' });
  if (!repoName || !/^[a-zA-Z0-9._-]+$/.test(repoName)) {
    return res.status(400).json({ error: 'Repo name must be letters, numbers, dots, dashes or underscores' });
  }
  if (!code) return res.status(400).json({ error: 'No build output to push' });

  const ghHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'ai-dream-builder'
  };

  try {
    // 1. Create the repo under the authenticated user's account
    const createRes = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: repoName,
        description: description || 'Built with AI Dream Builder',
        private: false,
        auto_init: false
      })
    });
    const repo = await createRes.json();
    if (!createRes.ok) {
      return res.status(createRes.status).json({ error: repo.message || 'Could not create GitHub repo' });
    }

    // 2. Commit the generated code as README.md-adjacent source file
    const contentB64 = Buffer.from(code, 'utf-8').toString('base64');
    const fileRes = await fetch(`https://api.github.com/repos/${repo.full_name}/contents/build.txt`, {
      method: 'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Initial commit from AI Dream Builder',
        content: contentB64
      })
    });
    const fileData = await fileRes.json();
    if (!fileRes.ok) {
      return res.status(fileRes.status).json({ error: fileData.message || 'Repo created, but committing the build failed' });
    }

    res.json({ htmlUrl: repo.html_url, fullName: repo.full_name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'GitHub push failed' });
  }
});



const adminAuth = basicAuth({
  users: { [process.env.ADMIN_USER || 'admin']: process.env.ADMIN_PASS || 'change-me' },
  challenge: true,
  realm: 'AI Dream Builder Admin'
});

app.use('/admin', adminAuth, express.static(path.join(__dirname, 'public')));

app.get('/admin/api/plans', adminAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM plans').all());
});

app.put('/admin/api/plans/:id', adminAuth, (req, res) => {
  const { name, price_cents, description, stripe_price_id, active } = req.body;
  db.prepare(`
    UPDATE plans SET name = ?, price_cents = ?, description = ?, stripe_price_id = ?, active = ?
    WHERE id = ?
  `).run(name, price_cents, description, stripe_price_id || null, active ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

app.post('/admin/api/plans', adminAuth, (req, res) => {
  const { id, name, price_cents, description, interval } = req.body;
  db.prepare(`
    INSERT INTO plans (id, name, price_cents, interval, description, active)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(id, name, price_cents, interval || 'month', description || '');
  res.json({ ok: true });
});

app.get('/admin/api/orders', adminAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 200').all());
});

app.get('/admin/api/stats', adminAuth, (req, res) => {
  const totalRevenue = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS n FROM orders WHERE status = 'paid'`).get().n;
  const paidOrders = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status = 'paid'`).get().n;
  const pendingOrders = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'`).get().n;
  res.json({ totalRevenue, paidOrders, pendingOrders });
});

app.listen(PORT, () => {
  console.log(`AI Dream Builder backend running on http://localhost:${PORT}`);
  console.log(`Admin CMS at http://localhost:${PORT}/admin`);
});
