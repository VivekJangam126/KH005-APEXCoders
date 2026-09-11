# ClaritySQL — Quick Start Guide

## Architecture

```
Frontend (React/Vite)  :5173
       ↓  /api/* proxied to
FastAPI Backend (Python) :8000
       ↓
PostgreSQL (Supabase cloud or local)
       ↓
Google Gemini API (LLM for SQL generation)
```

## Prerequisites

- **Node.js** 18+ and npm
- **Python** 3.9+
- **PostgreSQL** database (Supabase URL already configured in `.env`)

---

## Step 1 — Start the FastAPI Backend

Open a terminal and run:

```powershell
# Windows (PowerShell)
cd KH005-APEXCoders\backend
.\start.ps1
```

```bash
# Mac/Linux/Git Bash
cd KH005-APEXCoders/backend
chmod +x start.sh
./start.sh
```

Backend will be available at: **http://localhost:8000**  
API docs (Swagger UI): **http://localhost:8000/docs**

---

## Step 2 — Start the Frontend

Open a **separate** terminal and run:

```bash
cd KH005-APEXCoders/frontend
npm install      # only needed first time
npm run dev
```

Frontend will be available at: **http://localhost:5173**

---

## Environment Files

| File | Used By | Purpose |
|------|---------|---------|
| `backend/.env` | FastAPI (port 8000) | DB, LLM, limits config |
| `frontend/.env` | Vite dev server | API proxy target |
| `.env` (root) | Express (port 3000) | Alternative all-in-one setup |

### Frontend `.env`
```env
VITE_API_TARGET=http://localhost:8000
```

### Backend `.env`
```env
DATABASE_URL=postgresql://...
GEMINI_API_KEY=your-key
LLM_PROVIDER=gemini
GEMINI_MODEL=gemini-2.0-flash
```

---

## Alternative: Express All-in-One (port 3000)

If you prefer to run everything from the root with Express:

```bash
cd KH005-APEXCoders
npm install
npm run dev
```

Visit: **http://localhost:3000**

> Note: This runs the Express backend which also serves the frontend. No separate frontend server needed.

---

## Troubleshooting

### "Failed to fetch" / ERR_CONNECTION_REFUSED
- Make sure the FastAPI backend is running on port 8000
- Check that `frontend/.env` has `VITE_API_TARGET=http://localhost:8000`

### Database connection errors
- Verify `DATABASE_URL` in `backend/.env` is correct
- Test: `psql "your-database-url" -c "SELECT 1"`

### LLM / SQL generation not working
- Set `LLM_PROVIDER=gemini` and add a valid `GEMINI_API_KEY` in `backend/.env`
- Or install Ollama locally and set `LLM_PROVIDER=ollama`

### CSV import fails
- Ensure you're logged in as an `ORG_ADMIN` (Organization Administrator)
- Regular members cannot import CSV files

### WebSocket HMR errors
- These are harmless in some environments. Set `DISABLE_HMR=true` in `frontend/.env` to disable.
