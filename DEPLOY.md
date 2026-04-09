# Deployment Guide

Two services to deploy:
1. **Render.com** — Python API (runs predictions)
2. **Vercel** — Next.js dashboard (the website you visit)

---

## Step 1 — Push to GitHub

```bash
cd C:\Users\User\horse_racing
git init          # if not already a repo
git add .
git commit -m "Add web dashboard"
git remote add origin https://github.com/YOUR_USERNAME/horse_racing.git
git push -u origin master
```

> The `models/` directory (~14 MB) is included — no extra steps needed.

---

## Step 2 — Deploy API on Render.com

1. Go to [render.com](https://render.com) → **New → Web Service**
2. Connect your GitHub repo
3. Render auto-detects `render.yaml` — click **Apply**
4. Under **Environment Variables**, add:

   | Key | Value |
   |-----|-------|
   | `PYTHON_VERSION` | `3.11.0` |

5. Click **Create Web Service** — first build takes ~5 min (TensorFlow is large)
6. Once deployed, note your service URL:  
   `https://hkjc-racing-api.onrender.com`

> **Free tier note:** The service sleeps after 15 min idle. First request after sleep takes ~30 s to wake up. Subsequent requests are instant.

---

## Step 3 — Deploy Dashboard on Vercel

1. Go to [vercel.com](https://vercel.com) → **New Project** → Import your GitHub repo
2. In **Configure Project**, set **Root Directory** to `web`
3. Under **Environment Variables**, add:

   | Key | Value |
   |-----|-------|
   | `SITE_PASSWORD` | `your-chosen-password` |
   | `SESSION_TOKEN` | output of `openssl rand -hex 32` (or any long random string) |
   | `NEXT_PUBLIC_API_URL` | `https://hkjc-racing-api.onrender.com` (from Step 2, no trailing slash) |

4. Click **Deploy**

---

## Step 4 — Use It

1. Visit your Vercel URL (e.g. `https://horse-racing.vercel.app`)
2. Enter your password
3. Dashboard auto-detects the next race meeting
4. Click **Fetch Predictions**

### When to fetch
- **Race card** is usually published the day before (Saturday for Sunday, Tuesday for Wednesday)
- **Odds** open a few hours before the race; re-fetch once HKJC publishes them for full bet-sizing recommendations

---

## Local development

```bash
# API
pip install -r api/requirements.txt
uvicorn api.main:app --reload --port 8000

# Frontend (in a separate terminal)
cd web
cp .env.local.example .env.local   # edit the values
npm install
npm run dev
```

Then open http://localhost:3000
