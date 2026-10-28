# Grouply

Group-centric social platform. The **group** is the main content unit.

---

## Project structure

```
grouply/
├── backend/
│   ├── app.py              ← Flask entry point
│   ├── backend_auth.py     ← JWT verification + Supabase clients
│   └── requirements.txt
├── frontend/
│   ├── index.html          ← Main app (route-guarded)
│   ├── login.html          ← Auth flows (login/signup/forgot/reset)
│   ├── onboarding.html     ← First-login profile setup
│   ├── js/
│   │   ├── frontend_auth.js  ← supabase-js auth helpers + callApi
│   │   ├── login.js          ← Login page controller
│   │   ├── onboarding.js     ← Onboarding controller
│   │   └── app.js            ← Main app controller
│   └── css/
│       └── style.css         ← Design system (dark glassmorphism)
├── schema.sql                ← Base Supabase schema + RLS + triggers
├── migrations/
│   └── 002_grouply_additions.sql  ← M1 schema additions
├── .env.example
└── README.md
```

---

## Setup

### 1. Supabase (YOU do these in the dashboard)

#### Dashboard steps (exact click path)

**A. Create project**
- supabase.com → New project → choose name & password → Create project

**B. Run the schema**
- Dashboard → SQL Editor → New query → paste `schema.sql` → Run
- Then paste `migrations/002_grouply_additions.sql` → Run

**C. Enable Auth providers**
- Dashboard → Authentication → Providers
  - **Email**: enable ✅, set "Confirm email" to your preference (disable for dev)
  - **Google**: enable ✅ → you'll need a Google OAuth client (see §D)

**D. Google OAuth (for Sign in with Google)**
1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. New project → Enable **Google Identity Platform / OAuth**
3. APIs & Services → Credentials → Create OAuth Client ID
   - Type: **Web application**
   - Authorized redirect URI: copy the callback URL from Supabase Dashboard →
     Authentication → Providers → Google → (shows something like
     `https://<ref>.supabase.co/auth/v1/callback`)
4. Copy the **Client ID** and **Client Secret** back into the Supabase Google provider page
5. Save

**E. URL Configuration**
- Dashboard → Authentication → URL Configuration
  - Site URL: `http://localhost:5000` (update to your Render URL later)
  - Redirect URLs: add `http://localhost:5000/*` and `http://localhost:5000/login.html`

**F. Get your keys**
- Dashboard → Project Settings → API
  - `Project URL` → `SUPABASE_URL`
  - `anon / public` key → `SUPABASE_ANON_KEY`
  - `service_role / secret` key → `SUPABASE_SERVICE_ROLE_KEY`

**G. Check JWT mode**
- Dashboard → Project Settings → API → JWT Settings
  - If you see **JWT Secret** (a long string) → `JWT_MODE=symmetric`
  - If you see **asymmetric** or RS256 → `JWT_MODE=asymmetric` (most new projects)

---

### 2. Backend

```bash
cd grouply/backend
python -m venv venv
# Windows:
venv\Scripts\activate
# macOS/Linux:
source venv/bin/activate

pip install -r requirements.txt

# Copy and fill in the env file
copy .env.example .env    # (Windows)
# cp .env.example .env   # (macOS/Linux)
# Edit .env with your Supabase keys

python app.py
# → Flask running on http://localhost:5000
```

---

### 3. Frontend

The frontend is plain HTML/CSS/JS with no bundler.

1. Open `frontend/login.html`, `frontend/index.html`, and `frontend/onboarding.html`
2. In each file, replace the `window.GROUPLY_CONFIG` block:
   ```js
   window.GROUPLY_CONFIG = {
     SUPABASE_URL:     "https://YOUR_PROJECT_REF.supabase.co",
     SUPABASE_ANON_KEY: "your_anon_key_here",
     API_BASE_URL:     "http://localhost:5000",
   };
   ```
3. Serve with any static server. Easiest:
   ```bash
   cd grouply/frontend
   npx -y serve .
   # → open http://localhost:3000
   ```
   Or use VS Code Live Server / Python's `http.server`.

> **Note:** The frontend uses ES modules (`type="module"`). It MUST be served over HTTP — opening `file://` directly will fail due to CORS on module imports.

---

## Milestone 1 — Manual Test Checklist

Run through all of these after setup. Check ✅ when passing.

### Auth provider setup
- [ ] Supabase Dashboard shows Email provider = Enabled
- [ ] Supabase Dashboard shows Google provider = Enabled with Client ID

### Backend health
- [ ] `GET http://localhost:5000/api/health` → `{"status":"ok","service":"grouply-backend"}`

### Sign up (email)
- [ ] Open `login.html` → see login panel with "Grouply" logo
- [ ] Click "Sign up" → signup panel appears
- [ ] Submit empty form → shows field validation errors
- [ ] Sign up with a new email + password (8+ chars) → 
  - If email confirm disabled: redirected to `onboarding.html`
  - If email confirm enabled: alert "Check your email to confirm"
- [ ] After confirming email and signing in → `profiles` row exists in Supabase Table Editor

### Onboarding
- [ ] `onboarding.html` loads with auto-filled username (from email prefix)
- [ ] Typing in Username field → availability check fires after 0.5s debounce
- [ ] Try an already-taken username → shows "✗ Already taken"
- [ ] Submit valid username + display name → redirected to `index.html`
- [ ] `profiles` row now has `display_name` and the chosen `username`

### Sign in with Google
- [ ] On `login.html`, click "Continue with Google" → browser redirects to Google
- [ ] After Google consent → redirected back to `login.html` → then to `index.html`
- [ ] `profiles` row exists with Google-provided `display_name` and `avatar_url`

### Main app
- [ ] `index.html` shows the five-tab bottom bar: Feed, Explore, Groups, Chat, Profile
- [ ] Profile tab shows display name, `@username`, avatar initial or Google photo
- [ ] Explore tab shows 8 category tiles with correct emoji and gradient
- [ ] Groups tab shows empty state + "Create a group" button
- [ ] Create Group button / FAB → bottom sheet opens
- [ ] Fill in group name + click "Create Group" → shows Milestone 2 placeholder message
- [ ] Chat tab shows WhatsApp explanation card
- [ ] Sign out button → redirected to `login.html`

### Route guard
- [ ] Open `index.html` without being signed in → redirected to `login.html`
- [ ] Open `onboarding.html` without being signed in → redirected to `login.html`

### Protected API routes
- [ ] `GET /api/me` with valid Bearer token → returns profile JSON (200)
- [ ] `GET /api/me` with NO Authorization header → `{"error":"Missing or invalid Authorization header"}` (401)
- [ ] `GET /api/me` with expired/invalid token → 401

### Forgot password
- [ ] Click "Forgot password?" → forgot panel appears
- [ ] Enter registered email → "Reset link sent!" success alert
- [ ] Click the email link → lands on `login.html` → reset panel appears
- [ ] Enter new password + confirm → "Password updated" → redirected to app

---

## JWT mode note

`backend_auth.py` auto-detects based on `JWT_MODE` env var:
- `JWT_MODE=asymmetric` (default): verifies via JWKS endpoint at
  `https://<ref>.supabase.co/auth/v1/.well-known/jwks.json`
  This is correct for all new Supabase projects (RS256).
- `JWT_MODE=symmetric`: verifies with `SUPABASE_JWT_SECRET` (HS256).
  Use only for legacy projects created before ~2023.

Check: Dashboard → Project Settings → API → JWT Settings.
If you see "JWT Secret" shown as a plain string → symmetric.
If there's no exposed secret / shows asymmetric → set `JWT_MODE=asymmetric`.

---

## Google Drive connect note (Milestone 5)

When connecting Google Drive, the OAuth consent screen must be in **Production**
for refresh tokens to last more than 7 days. During development (Testing mode),
tokens expire after 7 days — the app will detect this, set `status='broken'` on
the connection, and prompt the admin to reconnect.

---

## Deploying to Render (later)

---

## Milestone 2 — Groups Core: New API Endpoints

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| POST | `/api/groups` | ✅ | Create group (calls `create_group()` SQL fn) |
| GET  | `/api/groups` | ✅ | List user's groups with role + member count |
| GET  | `/api/groups/<id>` | ✅ | Group detail + members list |
| POST | `/api/groups/<id>/join` | ✅ | Join a PUBLIC group |
| POST | `/api/groups/<id>/invite` | ✅ | Generate single-use invite code |
| POST | `/api/groups/join-by-code` | ✅ | Consume invite code + join group |

### Migration 003 — run after 002
```
Dashboard → SQL Editor → paste migrations/003_invite_codes.sql → Run
```

---

## Milestone 2 — Manual Test Checklist

### Groups tab
- [ ] Groups tab shows "No groups yet" empty state for a new user
- [ ] "🔗 Join with code" button always visible in Groups tab header
- [ ] FAB (＋) visible on Groups tab, hidden on all other tabs
- [ ] ＋ button in top-bar on Groups tab also opens Create Group sheet

### Create Group
- [ ] Open Create Group sheet → fill name only → click Create Group → group appears in list
- [ ] Create group with all fields (name, description, category=Travel, private=off) → success
- [ ] Creating group with empty name → shows "Group name is required" error
- [ ] After creating, sheet closes and Groups tab refreshes showing new card
- [ ] Group card shows: category emoji, gradient cover, name, member count, privacy badge
- [ ] Profile tab Groups count updates to reflect new group(s)

### Group Detail Sheet
- [ ] Tap any group card → detail sheet slides up
- [ ] Shows group name, category, member count, privacy badge
- [ ] Shows "Admin" badge if you are admin
- [ ] Description shows if present, hidden if empty
- [ ] Members list shows avatar initial + display name + @username for each member
- [ ] Admin member has "Admin" badge in members list
- [ ] Tap backdrop → sheet closes

### Invite Codes
- [ ] Click "Generate Invite Link" → shows 8-char code (e.g. `AB3XY7PQ`)
- [ ] Click "Copy" → clipboard gets the code, button shows "Copied!"
- [ ] Open a second browser / incognito → sign in as a different user
- [ ] Go to Groups tab → click "🔗 Join with code" → enter the code → "Joined!" success
- [ ] Open `index.html?invite=AB3XY7PQ` → join-by-code sheet auto-opens pre-filled
- [ ] Using the same code a second time → "Invalid or already-used invite code"

### Join Public Group
- [ ] Create a PUBLIC group (toggle off "Private")
- [ ] Second user calls `POST /api/groups/<id>/join` → 201 success
- [ ] Already-member user calling join → 409 "Already a member"

### Chat tab
- [ ] If user has NO groups → shows explanation placeholder
- [ ] If user has groups → shows list with group emoji + name + member count
- [ ] Group WITH whatsapp_link → clicking card opens WhatsApp in new tab
- [ ] Group WITHOUT whatsapp_link → clicking card opens group detail sheet
- [ ] Note at bottom if no groups have WhatsApp links

### Profile tab
- [ ] Shows count of groups user belongs to
- [ ] Shows a group card for each group (same design as Groups tab)
- [ ] Clicking a profile tab group card opens the detail sheet

---

## Milestone 3 — Profile ("The Flex"): New API Endpoints

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| PUT / PATCH | `/api/me` | ✅ | Update profile (`display_name`, `username`, `bio`, `avatar_url`) |
| GET | `/api/profiles/<user_id>` | ✅ | Public profile + visible groups ("the flex") & total count |

---

## Milestone 3 — Manual Test Checklist

### Edit Profile Flow
- [ ] On Profile tab, tap "✏️ Edit profile" → bottom sheet opens pre-filled with current info
- [ ] Change display name or bio → tap "Save Changes" → profile header updates instantly
- [ ] Live username check: type a new username → shows "Checking availability…" then "✓ Username available" or "✗ Username already taken"
- [ ] Test collision: typing another user's username shows taken error and prevents saving
- [ ] Test empty display name: shows field error "Display name is required"
- [ ] Update avatar URL: image updates immediately in profile header

### Profile "The Flex" & Stats
- [ ] Stats bar shows: Groups count, Admin In count, Categories explored count
- [ ] If user has 0 groups: empty state message encouraging joining circles
- [ ] If user has groups: rich group cards showing category emojis, cover gradients, role tag, and privacy badges
- [ ] Clicking any group card in the Profile tab opens that group's detail sheet

### Member Profiles & Circles Inspection
- [ ] Open any group detail sheet → scroll to Members list
- [ ] Tap on any member in the list → Member Profile modal slides up
- [ ] Shows their Avatar, Display Name, `@username`, Bio, Total Groups count, and Visible Circles count
- [ ] Only public groups and mutual groups shared with you appear in their visible circles list (RLS-safe)
- [ ] Tapping a group card in their profile modal opens that group's details

---

## Deploying to Render (later)
1. Add a `render.yaml` or configure manually:
   - Backend: Python web service, `cd backend && pip install -r requirements.txt`
   - Start command: `gunicorn app:app`
2. Set all env vars in Render dashboard
3. Update Supabase URL Config with the Render URL
4. Frontend can be deployed as a Render Static Site or Firebase Hosting

