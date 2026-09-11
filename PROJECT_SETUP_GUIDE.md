# KH005-APEXCoders Project Setup Guide

## Project Overview

**Project Name:** Speak2SQL / ClaritySQL

**What is this project?**
This is a full-stack web application that enables users to query databases using natural language. It combines AI-powered SQL generation with a user-friendly interface for data analysis.

### Key Features:
1. **Natural Language Query Interface** - Users ask questions in English, and the system generates and executes SQL queries
2. **Multi-User Authentication** - User accounts with sessions and role-based access control
3. **Database Schema Management** - Automatic schema extraction and metadata management
4. **Data Import & Management** - CSV file uploads and database table creation
5. **Query History & Auditing** - Track all executed queries and user activities
6. **Admin Dashboard** - Administrative controls for user management and system monitoring
7. **AI-Powered Insights** - Generate grounded insights from query results
8. **Real-time Data Exploration** - View database contents, schemas, and table relationships

---

## Technology Stack

### Frontend
- **Framework:** React 19 with TypeScript
- **Build Tool:** Vite
- **UI Components:** Tailwind CSS, Lucide React, Motion animations
- **State Management:** React Context API
- **Charts:** Recharts for data visualization

### Backend
- **Runtime:** Node.js with Express
- **Language:** TypeScript
- **Database Adapter:** PostgreSQL (pg) with PGlite fallback
- **AI Integration:** Google Gemini API (@google/genai)
- **File Processing:** Multer (uploads), CSV-parse, PDF-parse, Mammoth (Word docs), XLSX
- **Authentication:** Custom session-based auth with password hashing
- **ORM/Query:** Direct SQL with parameterized queries

### Database
- **Primary:** PostgreSQL (required for production)
- **Schema:** Multiple schemas (clarity_app for core data, user-specific schemas for datasets)
- **Data Persistence:** Disk-based pgdata directory

### Environment
- Node.js with npm/bun
- Port 3000 (backend API)
- Port 5173 (frontend dev server via Vite)

---

## Current Project Status

### ✅ What Has Been Done

1. **Repository Setup**
   - Cloned main branch and merged with existing dev-omkar branch
   - Resolved git merge conflicts (README.md)
   - Project structure fully initialized

2. **Environment Configuration**
   - Created `.env` file with development settings
   - Configured following environment variables:
     ```
     GEMINI_API_KEY = "sk-placeholder" (needs real API key)
     GEMINI_MODEL = "gemini-2.0-flash"
     APP_URL = "http://localhost:5173"
     DATABASE_URL = "" (needs configuration)
     NODE_ENV = "development"
     Query timeouts, CSV limits configured
     ```

3. **Dependencies Installation**
   - Ran `npm install` successfully
   - Installed 435 packages
   - Fixed deprecated warnings
   - Ready for development

4. **Project Exploration**
   - Analyzed full project structure
   - Identified key components:
     - 15+ React components for different views
     - 12+ backend route/service modules
     - Database abstraction layer with multi-pool support
     - CSV/Excel import pipelines
     - Gemini AI integration

---

## Project Structure

```
KH005-APEXCoders/
├── src/                          # Frontend React app
│   ├── components/
│   │   ├── analyst/             # Main query interface
│   │   ├── database/            # Database browser & data explorer
│   │   ├── schema/              # Schema visualization
│   │   ├── history/             # Query history view
│   │   ├── admin/               # Admin dashboard
│   │   ├── auth/                # Login/signup screens
│   │   ├── settings/            # User settings
│   │   └── layout/              # Navigation & layout
│   ├── context/                 # React Context (Auth, Data)
│   ├── lib/                     # API client helpers
│   ├── types/                   # TypeScript interfaces
│   ├── App.tsx                  # Main app component
│   └── main.tsx                 # Entry point
├── server/                       # Backend Express app
│   ├── routes.ts                # Main API routes
│   ├── admin-routes.ts          # Admin endpoints
│   ├── data-routes.ts           # Data exploration endpoints
│   ├── auth.ts                  # Authentication logic
│   ├── authorization.ts         # Authorization & audit logging
│   ├── db.ts                    # Database adapters
│   ├── db-config-resolver.ts    # DB connection config resolution
│   ├── schema.ts                # Schema metadata extraction
│   ├── csv.ts                   # CSV parsing & import
│   ├── gemini.ts                # Google Gemini API integration
│   ├── execution.ts             # Query execution & preview
│   ├── ingestion-agent.ts       # Data ingestion pipeline
│   ├── config.ts                # Configuration loader
│   └── seed.ts                  # Demo data seeding
├── server.ts                     # Express server entry point
├── vite.config.ts               # Vite bundler config
├── tsconfig.json                # TypeScript config
├── package.json                 # Dependencies & scripts
├── index.html                   # HTML entry point
├── .env                         # Environment variables (created)
├── .env.example                 # Template for .env
├── data/pgdata/                 # PostgreSQL data directory
└── README.md                    # Project description

Key Directories:
- /src                          → React frontend code
- /server                       → Express backend modules
- /public                       → Static assets
- /dist                         → Production build output
- /data/pgdata                  → PostgreSQL database files
```

---

## Available NPM Scripts

```bash
# Development
npm run dev              # Start dev server (tsx server.ts) - runs on port 3000
                        # Vite frontend bundler on port 5173

# Production
npm run build            # Build frontend (vite build) + backend (esbuild)
                        # Outputs to /dist directory
npm run start            # Start production server (node dist/server.cjs)

# Utilities
npm run preview          # Preview production build locally
npm run clean            # Remove dist directory and build artifacts
npm run lint             # Type check without emitting (tsc --noEmit)
```

---

## Current Issues & What Needs To Be Done

### 🔴 Critical Issues

1. **Database Connection Required**
   - Current error: `DATABASE_URL is not configured`
   - **Solution needed:** Must configure a PostgreSQL database
   - Options:
     - Connect to existing PostgreSQL server (provide connection URL)
     - Use local PostgreSQL installation
     - Use cloud PostgreSQL (Neon, Supabase, AWS RDS, etc.)
   - Format: `postgresql://user:password@host:port/dbname`

2. **Google Gemini API Key**
   - Current: Using placeholder "sk-placeholder"
   - **Solution needed:** Obtain real Gemini API key from Google AI Studio
   - Set in `.env` as: `GEMINI_API_KEY=your_real_key_here`

### 🟡 Next Steps (In Order)

1. **Setup PostgreSQL Database**
   - Verify PostgreSQL is running
   - Create a database for the application
   - Get connection URL
   - Update `.env` with DATABASE_URL

2. **Configure Google Gemini API**
   - Visit: https://ai.google.dev/
   - Create/get API key
   - Add to `.env` GEMINI_API_KEY

3. **Run Database Migrations**
   - Initialize core schema (clarity_app)
   - Create user tables
   - Seed demo data if needed

4. **Test Backend API**
   - Verify database connection
   - Test health check endpoint: `GET /api/health`
   - Test authentication endpoints

5. **Test Frontend**
   - Verify Vite dev server starts
   - Test login page
   - Test analyst view with sample queries

6. **Full Integration Testing**
   - Create test user
   - Import sample CSV data
   - Execute natural language queries
   - Verify AI response generation

---

## Database Schema Overview

The application uses PostgreSQL with multiple schemas:

### Main Schema: `clarity_app`
- `users` - User accounts with authentication
- `sessions` - Active user sessions
- `datasets` - Imported datasets metadata
- `query_history` - All executed queries with results
- `audit_logs` - System activity logs

### User Schemas: `schema_<dataset_id>`
- Dynamically created for each imported dataset
- Contains tables uploaded via CSV/Excel

---

## API Endpoints (Summary)

### Authentication
- `POST /api/auth/login` - User login
- `POST /api/auth/signup` - User registration
- `POST /api/auth/logout` - Session termination
- `GET /api/auth/me` - Current user info

### Queries (Analyst)
- `POST /api/query/understand` - Parse natural language question
- `POST /api/query/preview` - Generate and preview SQL
- `POST /api/query/execute` - Execute query and get results
- `POST /api/query/correct` - AI SQL correction

### Database
- `GET /api/data/schema` - Get database schema metadata
- `POST /api/data/import` - Import CSV/Excel files
- `GET /api/data/tables` - List all tables
- `GET /api/data/records` - Fetch table data with pagination

### Admin
- `GET /api/admin/users` - List all users (admin only)
- `POST /api/admin/users/<id>/suspend` - Suspend user
- `GET /api/admin/audit-logs` - View audit logs

---

## Development Workflow

1. **Start Development Server**
   ```bash
   npm run dev
   ```
   - Backend runs on `http://localhost:3000`
   - Frontend runs on `http://localhost:5173` (via Vite)

2. **Access Application**
   - Open browser to `http://localhost:5173`
   - Login with test credentials or signup

3. **Make Code Changes**
   - Frontend changes (src/) auto-reload via Vite HMR
   - Backend changes require manual restart (npm run dev)

4. **Check Compilation**
   ```bash
   npm run lint
   ```

---

## Configuration Details

### Environment Variables Explained

| Variable | Purpose | Example |
|----------|---------|---------|
| `GEMINI_API_KEY` | Google AI API authentication | `sk-abc123...` |
| `GEMINI_MODEL` | AI model version | `gemini-2.0-flash` |
| `APP_URL` | Application URL for redirects | `http://localhost:5173` |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@localhost:5432/claritysql` |
| `NODE_ENV` | Runtime environment | `development` or `production` |
| `MAX_CSV_BYTES` | Max file upload size | `26214400` (25MB) |
| `MAX_CSV_ROWS` | Max rows per import | `100000` |
| `QUERY_TIMEOUT_MS` | SQL query timeout | `15000` (15 seconds) |

### Database Connection URL Format
```
postgresql://username:password@hostname:port/database_name
```

Example:
```
postgresql://admin:mypassword@localhost:5432/claritysql
```

---

## Build & Deployment

### Production Build
```bash
npm run build
# Creates /dist directory with:
# - dist/index.html (React app bundle)
# - dist/server.cjs (Node.js server bundle)
```

### Start Production Server
```bash
npm run start
# Runs bundled server on port 3000
# Serves static frontend from /dist
```

### Deployment Options
- **Local Server:** Run `npm run start`
- **Docker:** Create Dockerfile with Node.js image
- **Cloud Platforms:** Vercel, Netlify, Railway, Heroku, AWS, GCP, Azure
- **AI Studio:** Deploy via Google Cloud's AI Studio UI

---

## Troubleshooting

### Issue: "DATABASE_URL is not configured"
**Solution:** 
1. Add `DATABASE_URL` to `.env`
2. Ensure PostgreSQL is running
3. Test connection: `psql postgresql://user:pass@host:port/db`

### Issue: "GEMINI_API_KEY not found"
**Solution:**
1. Get API key from https://ai.google.dev/
2. Add to `.env`: `GEMINI_API_KEY=your_key`

### Issue: "Port 3000 already in use"
**Solution:** 
- Kill process on port 3000
- Or change PORT in server.ts

### Issue: "npm ERR! Module not found"
**Solution:**
1. Delete node_modules: `rm -rf node_modules`
2. Clear npm cache: `npm cache clean --force`
3. Reinstall: `npm install`

---

## Key Files to Understand

| File | Purpose |
|------|---------|
| `server.ts` | Express server setup, middleware, routes mounting |
| `server/routes.ts` | Main API route definitions |
| `server/auth.ts` | User authentication logic |
| `server/db.ts` | Database adapter and connection pooling |
| `server/gemini.ts` | Google Gemini API integration for SQL generation |
| `src/App.tsx` | Main React component with routing |
| `src/context/AuthContext.tsx` | User auth state management |
| `src/components/analyst/AnalystView.tsx` | Main query interface |
| `vite.config.ts` | Frontend bundler configuration |
| `tsconfig.json` | TypeScript compiler options |

---

## Next Actions for Deployment/Running

### Immediate Steps:
1. ✅ Project cloned and dependencies installed
2. ⏳ **Configure PostgreSQL database** (required)
3. ⏳ **Add Gemini API key** (required)
4. ⏳ Run `npm run dev` to start servers
5. ⏳ Test in browser at http://localhost:5173
6. ⏳ Create test account and verify functionality

### Then Share With ChatGPT:
- This file (PROJECT_SETUP_GUIDE.md)
- Request: "Help me complete the remaining setup steps and debug any issues"
- ChatGPT can then help with:
  - PostgreSQL setup commands
  - API key configuration
  - Database initialization
  - Testing procedures
  - Deployment guidance

---

## Summary

- **Status:** ✅ Project structure ready, dependencies installed, environment configured
- **Blockers:** ⏳ Need PostgreSQL connection and Gemini API key
- **Next:** Configure database → Run dev server → Test application

---

*Last Updated: September 11, 2026*
*Project: Speak2SQL / ClaritySQL - Full Stack AI-Powered Database Query Application*
