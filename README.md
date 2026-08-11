# AI Dream Builder backend — payments CMS

Express + SQLite + Stripe. Handles checkout, webhooks, an admin CMS for
managing plans/orders, and a thin proxy for AI generation calls.

## 1. Install & configure

```bash
cd backend
npm install
cp .env.example .env
```

Fill in `.env`:
- `STRIPE_SECRET_KEY` — from the Stripe dashboard (use a `sk_test_...` key while developing)
- `STRIPE_WEBHOOK_SECRET` — from `stripe listen` (see below) or your webhook endpoint settings
- `ADMIN_USER` / `ADMIN_PASS` — login for `/admin`
- `ANTHROPIC_API_KEY` — only needed if you use `/api/generate`

## 2. Run it

```bash
npm start
```

The API runs on `http://localhost:4000`. The database file `app.db`
is created automatically on first run, seeded with three plans:
Starter (free), Builder ($29/mo), Team ($99/mo).

## 3. Forward Stripe webhooks locally

```bash
stripe listen --forward-to localhost:4000/api/webhook
```

Copy the `whsec_...` value it prints into `STRIPE_WEBHOOK_SECRET` in `.env`.

## 4. Admin CMS

Visit `http://localhost:4000/admin` and log in with `ADMIN_USER` /
`ADMIN_PASS`. From there you can:
- Edit plan names, prices, and Stripe price IDs
- Toggle plans active/inactive
- See total revenue and every checkout (paid + pending)

## 5. Connect the landing page

In `index.html`, set:

```js
const BACKEND_URL = "http://localhost:4000"; // or your deployed URL
```

The pricing buttons already call `POST /api/checkout` with
`{ plan: "starter" | "builder" | "team" }` and redirect to the
returned Stripe Checkout URL.

## 6. "Push to GitHub" from a build

Once a free build finishes, the landing page shows a small form asking
for a GitHub **personal access token** (classic, `repo` scope, or a
fine-grained token with "Contents: Read and write" on new repos) and
a repo name. On submit it calls `POST /api/github/push`, which:

1. Creates a new public repo under the token owner's account
2. Commits the generated output as `build.txt` in that repo
3. Returns the repo URL, which the page then turns into one-click
   **Deploy to Vercel** / **Deploy to Netlify** links using their
   standard git-import URL patterns

The token is only ever used in-memory for that one request — it is
never written to the database or to disk, and `githubLimiter` caps
pushes to 10 per IP per hour.

**Security note:** asking visitors to paste a personal access token
is the fastest way to ship this, but it's not what you'd want in a
real product — a leaked or intercepted token gives full `repo` scope
access to whatever it's scoped to. For production, replace this with
a proper **"Sign in with GitHub" OAuth App** flow (GitHub issues a
short-lived, narrowly-scoped token per user instead of a long-lived
personal one), and always serve this over HTTPS.

## 7. Free "build it" box on the landing page

The hero section has a real prompt box that calls `POST /api/generate`
using **your** `ANTHROPIC_API_KEY` on the server — visitors don't need
their own key. To keep that from being drained by abuse, it's
rate-limited to 5 free builds per IP per hour (see `generateLimiter`
in `server.js`) and capped at 1200 output tokens per build. Adjust
both to fit your budget.

## 8. Deploying

Any Node host works (Render, Railway, Fly.io, a VPS). Two things to set up:
- Point the Stripe webhook endpoint at `https://your-domain.com/api/webhook`
  and use its signing secret.
- Set `FRONTEND_URL` in `.env` to your deployed landing page's URL so
  Stripe redirects land back on the right domain.

`better-sqlite3` is file-based — for serious scale, swap `db.js` for
Postgres (the query shapes are simple and port over directly).

## Notes on what's real vs. scaffolded

- **Payments**: fully functional once you add real Stripe keys — this
  is a working checkout + webhook + order ledger, not a mock.
- **Admin CMS**: fully functional, backed by SQLite.
- **`/api/generate`**: a minimal working proxy to Claude. Swap in
  OpenAI/Gemini the same way, or extend it to actually write files to
  a project and stream output — that's the part that turns this into
  a full bolt.new-style builder rather than a marketing site with a demo hero.
