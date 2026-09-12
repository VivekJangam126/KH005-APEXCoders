const fs = require('fs');
const p = '.env.example';
if (!fs.existsSync(p)) process.exit(0);
const c = fs.readFileSync(p, 'utf8');
const hasSecret =
  c.includes('AQ.Ab8RN6J8NSmkr0') ||
  c.includes('819qIsfggHE5lPQS') ||
  c.includes('wsqvmnznwjchycekauxc') ||
  c.includes('<<<<<<') ||
  c.includes('>>>>>>>');
if (!hasSecret) process.exit(0);
fs.writeFileSync(p,
`# Required: Google Gemini API key
# Get one free at https://aistudio.google.com
GEMINI_API_KEY=your-gemini-api-key-here

# Optional: Gemini model override (default: gemini-3.6-flash)
GEMINI_MODEL=gemini-3.6-flash

# Required: PostgreSQL connection string
# Example: postgresql://user:password@host:5432/dbname
DATABASE_URL=

# Optional: Public URL of the deployed app
APP_URL=http://localhost:3000

# System limits (optional, shown with defaults)
MAX_CSV_BYTES=26214400
MAX_CSV_ROWS=100000
MAX_CSV_COLUMNS=200
MAX_RESULT_ROWS=1000
MAX_RESULT_BYTES=5242880
QUERY_TIMEOUT_MS=15000
MAX_SQL_CORRECTIONS=3
PREVIEW_TTL_SECONDS=900
NODE_ENV=development
`);
