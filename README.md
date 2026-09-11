# Ask2SQL — APEXCoders

> **AI-powered natural-language SQL analytics platform for multi-tenant organisations.**
> Ask questions in plain English, get instant SQL, charts, and grounded insights — all backed by a live PostgreSQL database and strict role-based access control.

---

## 🚀 Features

| Category | Highlights |
|---|---|
| **AI Analytics** | Ask any question in plain English → Gemini generates & validates SQL → returns results + grounded insight cards |
| **Multi-Format Ingestion** | Upload CSV, Excel (.xlsx/.xls), JSON, PDF, Word (.docx), and plain-text files; AI agent extracts tabular data when deterministic parsing is not enough |
| **Live PostgreSQL** | Connects to any PostgreSQL provider (Supabase, Neon, RDS, Cloud SQL) via a single `DATABASE_URL` — no embedded database, no demo mode |
| **Multi-Tenant RBAC** | Organisation-scoped data; admin-controlled user provisioning; per-database permission grants |
| **SQL Review** | Every AI-generated query is validated before execution; admins approve schema changes |
| **Charts & History** | Query results rendered as interactive charts (Recharts); full query history with search/filter |
| **Export** | Download results as CSV or JSON at any time |
| **Audit Trail** | Immutable audit log of every admin action, user creation, and data operation |
| **Responsive UI** | Dark-mode capable, glassmorphism design built with React + Tailwind CSS |

---

## 🏗️ Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | React 19, TypeScript, Vite, Tailwind CSS v4, Recharts, Lucide React |
| **Backend** | Node.js, Express, tsx (ESM-native) |
| **AI** | Google Gemini API (`@google/genai`) — text generation, structured output, multimodal |
| **Database** | PostgreSQL (Supabase / any provider) via `pg` pool |
| **File Parsing** | csv-parse, xlsx, pdf-parse, mammoth (Word) |
| **Auth** | Session-cookie + Bearer-token hybrid; bcrypt-style password hashing |

---

## 📋 Prerequisites

- **Node.js** v18 or later
- **npm** v9 or later
- A **PostgreSQL** database (Supabase free tier works perfectly)
- A **Google Gemini API key** (get one free at https://aistudio.google.com)

---

## ⚡ Quick Start

### 1. Clone the repository

```bash
git clone https://github.com/VivekJangam126/KH005-APEXCoders.git
cd KH005-APEXCoders
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Create a `.env` file in the project root:

```env
# Required: Gemini AI API Key
GEMINI_API_KEY="your-gemini-api-key"

# Required: PostgreSQL connection string (Supabase Transaction Pooler recommended)
DATABASE_URL="postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres"

# Optional: Gemini model override
GEMINI_MODEL="gemini-2.0-flash"
```

> **Supabase tip:** Use the **Transaction Pooler** string (port `6543`) — not the direct connection — for full IPv4 compatibility.

### 4. Start the development server

```bash
npm run dev
```

The application is available at **http://localhost:3000**

---

## 👥 User Roles & Flow

### Organisation Admin

1. Visit `/register` to create your organisation with your name, email, and password.
2. Log in and navigate to **Admin Panel → Members & Roles**.
3. Create team members by entering their **name, email, password, and permission level**.
4. Share the credentials with your team — they log in directly at `/login`.

### Team Member

1. Receive credentials from your admin.
2. Log in at `/login`.
3. Access the databases your admin has granted you access to.

> ⚠️ There is **no public self-registration** for regular users. Only the Org Admin can provision new accounts.

---

## 🔐 Permission Model

| Action | Org Admin | Read & Write | Read Only |
|---|:-:|:-:|:-:|
| View / query data | ✅ | ✅ | ✅ |
| Export CSV / JSON | ✅ | ✅ | ✅ |
| Upload files & import data | ✅ | ✅ | ❌ |
| Insert / Update records | ✅ | ✅ | ❌ |
| Delete records | ✅ | ❌ | ❌ |
| Create database | ✅ | ❌ | ❌ |
| Delete database | ✅ | ❌ | ❌ |
| Manage users | ✅ | ❌ | ❌ |
| View audit logs | ✅ | ❌ | ❌ |

---

## 📁 Project Structure

```
Ask2SQL/
├── server/
│   ├── server.ts              # Express app entry point
│   ├── routes.ts              # Main API router
│   ├── admin-routes.ts        # Org management, user CRUD, RBAC
│   ├── data-routes.ts         # Dataset & table operations
│   ├── auth.ts                # Session management, password hashing
│   ├── authorization.ts       # Server-side RBAC enforcement
│   ├── db.ts                  # PostgreSQL pool adapter & migrations
│   ├── ingestion-agent.ts     # Multi-format file ingestion (AI-assisted)
│   ├── gemini.ts              # Gemini AI integration
│   ├── execution.ts           # Query preview & execution
│   └── config.ts              # Centralised configuration
├── src/
│   ├── components/
│   │   ├── admin/             # Admin Panel (user management, audit logs)
│   │   ├── analyst/           # AI query interface & chart rendering
│   │   ├── database/          # Database manager & file upload wizard
│   │   ├── history/           # Query history
│   │   └── auth/              # Login & registration forms
│   ├── context/               # React contexts (Auth, Data)
│   ├── lib/api.ts             # Typed API client
│   └── types/                 # Shared TypeScript types
├── .env                       # Local secrets (git-ignored)
├── .env.example               # Template for environment variables
└── package.json
```

---

## 🗄️ Database Schema

All tables live in the `clarity_app` schema (isolated from `public`):

| Table | Purpose |
|---|---|
| `organizations` | Multi-tenant org records |
| `users` | User accounts (admin-provisioned) |
| `organization_memberships` | Org ↔ user binding with role & status |
| `database_permissions` | Per-dataset permission grants (read/write flags) |
| `datasets` | Analytical database metadata |
| `sessions` | Server-side session tokens |
| `analyses` | AI analysis records (question → SQL → result) |
| `uploads` | File upload audit records |
| `audit_events` | Immutable admin action log |

Migrations run automatically on every server startup — no manual SQL needed.

---

## 🛠️ Available Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start the development server (backend + Vite HMR) |
| `npm run build` | Build the production bundle |
| `npm run start` | Run the production build |
| `npm run lint` | TypeScript type checking |

---

## 🌐 Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `GEMINI_API_KEY` | ✅ | Google Gemini API key |
| `GEMINI_MODEL` | Optional | Model name (default: `gemini-2.0-flash`) |
| `NODE_ENV` | Optional | Set to `production` for production builds |
| `MAX_CSV_BYTES` | Optional | Max upload size in bytes (default: 25 MB) |
| `QUERY_TIMEOUT_MS` | Optional | SQL query timeout (default: 15 s) |

---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Commit your changes: `git commit -m "feat: describe your change"`
4. Push to the branch: `git push origin feature/your-feature`
5. Open a Pull Request against `main`

---

## 📄 License

MIT License

---

## 👤 Author

**VivekJangam126** — APEX Coders Team | MIT Kurukshetra Hackathon KH005
0.

