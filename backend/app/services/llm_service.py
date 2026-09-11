"""
LLM Service - Supports Ollama, Gemini, Together AI
Same logic as Node.js gemini.ts + llm-adapter.ts
"""
import re
import httpx
import json
from typing import Optional
from app.config import settings


class LLMService:
    _provider: Optional[str] = None

    @classmethod
    async def initialize(cls):
        """Detect which LLM provider is available"""
        # Try Ollama first (local, free)
        if settings.LLM_PROVIDER == "ollama" or not settings.LLM_PROVIDER:
            try:
                async with httpx.AsyncClient(timeout=3) as client:
                    r = await client.get(f"{settings.OLLAMA_BASE_URL}/api/tags")
                    if r.status_code == 200:
                        cls._provider = "ollama"
                        print(f"[LLM] Using Ollama ({settings.OLLAMA_MODEL})")
                        return
            except Exception:
                pass

        # Try Gemini
        if settings.GEMINI_API_KEY and (settings.LLM_PROVIDER == "gemini" or not cls._provider):
            cls._provider = "gemini"
            print(f"[LLM] Using Gemini ({settings.GEMINI_MODEL})")
            return

        # Try Together AI
        if settings.TOGETHER_API_KEY:
            cls._provider = "together"
            print(f"[LLM] Using Together AI ({settings.TOGETHER_MODEL})")
            return

        # Try OpenRouter
        if settings.OPENROUTER_API_KEY:
            cls._provider = "openrouter"
            print(f"[LLM] Using OpenRouter ({settings.OPENROUTER_MODEL})")
            return

        print("[LLM] No LLM provider available. Using deterministic SQL generation.")
        cls._provider = None

    @classmethod
    async def generate(cls, prompt: str, temperature: float = 0.1) -> Optional[str]:
        if cls._provider == "ollama":
            return await cls._ollama_generate(prompt, temperature)
        elif cls._provider == "gemini":
            return await cls._gemini_generate(prompt, temperature)
        elif cls._provider == "together":
            return await cls._together_generate(prompt, temperature)
        elif cls._provider == "openrouter":
            return await cls._openrouter_generate(prompt, temperature)
        return None

    @classmethod
    async def _ollama_generate(cls, prompt: str, temperature: float) -> Optional[str]:
        try:
            async with httpx.AsyncClient(timeout=120) as client:
                r = await client.post(
                    f"{settings.OLLAMA_BASE_URL}/api/generate",
                    json={
                        "model": settings.OLLAMA_MODEL,
                        "prompt": prompt,
                        "stream": False,
                        "options": {"temperature": temperature, "top_p": 0.95},
                    }
                )
                r.raise_for_status()
                return r.json().get("response", "")
        except Exception as e:
            print(f"[Ollama] Error: {e}")
            return None

    @classmethod
    async def _gemini_generate(cls, prompt: str, temperature: float) -> Optional[str]:
        try:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{settings.GEMINI_MODEL}:generateContent?key={settings.GEMINI_API_KEY}"
            async with httpx.AsyncClient(timeout=30) as client:
                r = await client.post(
                    url,
                    json={
                        "contents": [{"parts": [{"text": prompt}]}],
                        "generationConfig": {"temperature": temperature}
                    }
                )
                r.raise_for_status()
                data = r.json()
                return data["candidates"][0]["content"]["parts"][0]["text"]
        except Exception as e:
            print(f"[Gemini] Error: {e}")
            return None

    @classmethod
    async def _together_generate(cls, prompt: str, temperature: float) -> Optional[str]:
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                r = await client.post(
                    "https://api.together.xyz/inference",
                    headers={"Authorization": f"Bearer {settings.TOGETHER_API_KEY}"},
                    json={
                        "model": settings.TOGETHER_MODEL,
                        "prompt": prompt,
                        "max_tokens": 2048,
                        "temperature": temperature,
                    }
                )
                r.raise_for_status()
                return r.json().get("output", {}).get("choices", [{}])[0].get("text", "")
        except Exception as e:
            print(f"[Together AI] Error: {e}")
            return None

    @classmethod
    async def _openrouter_generate(cls, prompt: str, temperature: float) -> Optional[str]:
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                r = await client.post(
                    "https://openrouter.ai/api/v1/chat/completions",
                    headers={"Authorization": f"Bearer {settings.OPENROUTER_API_KEY}"},
                    json={
                        "model": settings.OPENROUTER_MODEL,
                        "messages": [{"role": "user", "content": prompt}],
                        "temperature": temperature,
                    }
                )
                r.raise_for_status()
                return r.json().get("choices", [{}])[0].get("message", {}).get("content", "")
        except Exception as e:
            print(f"[OpenRouter] Error: {e}")
            return None


def format_schema_for_prompt(tables: list) -> str:
    parts = []
    for t in tables:
        cols = "\n".join(
            f"  - {c['name']} ({c['dataType']}"
            + (", PK" if c.get("isPrimaryKey") else "")
            + (f", FK -> {c['foreignKey']['targetTable']}.{c['foreignKey']['targetColumn']}" if c.get("foreignKey") else "")
            + ")"
            for c in t["columns"]
        )
        parts.append(f'Table: "{t["name"]}" ({t["rowCount"]} rows)\nColumns:\n{cols}')
    return "\n\n".join(parts)


def clean_sql_output(raw: str) -> str:
    """Strip LLM explanations and extract only the SQL query"""
    raw = re.sub(r'```sql', '', raw, flags=re.IGNORECASE)
    raw = re.sub(r'```', '', raw)
    # Remove everything before SELECT
    match = re.search(r'SELECT', raw, re.IGNORECASE)
    if match:
        raw = raw[match.start():]
    # Keep only up to first semicolon
    semi = raw.find(';')
    if semi != -1:
        raw = raw[:semi + 1]
    # Remove trailing explanations after newlines
    raw = re.sub(r'\n\n.*', '', raw, flags=re.DOTALL)
    raw = raw.strip()
    if raw and not raw.endswith(';'):
        raw += ';'
    return raw


def generate_deterministic_sql(question: str, tables: list) -> str:
    """Rule-based SQL generator - same logic as Node.js generateDeterministicSql"""
    if not tables:
        return "SELECT 1;"

    lower = question.lower()

    # Find common tables
    students = next((t for t in tables if t["name"].lower() == "students"), None)
    attendance = next((t for t in tables if t["name"].lower() == "attendance"), None)
    courses = next((t for t in tables if t["name"].lower() == "courses"), None)
    departments = next((t for t in tables if t["name"].lower() == "departments"), None)

    # PRIORITY 1: Name/value filter detection
    filter_value = None
    quoted = re.search(r'["\']([^"\']+)["\']', question)
    if quoted:
        filter_value = quoted.group(1)
    else:
        capital = re.search(r'\b([A-Z][a-z]+ [A-Z][a-z]+)\b', question)
        if capital:
            filter_value = capital.group(1)

    # Find primary table based on question keywords
    primary_table = next((t for t in tables if t["name"].lower() in lower), tables[0])

    if filter_value:
        # Find table with name column
        if students and any("name" in c["name"].lower() for c in students["columns"]):
            primary_table = students
        name_cols = [c for c in primary_table["columns"] if "TEXT" in c.get("dataType", "") or "VARCHAR" in c.get("dataType", "")]
        name_col = next((c for c in name_cols if "name" in c["name"].lower()), name_cols[0] if name_cols else None)
        if name_col:
            safe_val = filter_value.replace("'", "''")
            return f'SELECT * FROM "{primary_table["name"]}" WHERE "{name_col["name"]}" ILIKE \'%{safe_val}%\' LIMIT 1000;'

    # PRIORITY 2: Attendance with joins
    if attendance and students and courses and "attendance" in lower:
        return (
            f'SELECT a.attendance_id, s.name, c.title, a.date, a.status '
            f'FROM "{attendance["name"]}" a '
            f'JOIN "{students["name"]}" s ON a.student_id = s.student_id '
            f'JOIN "{courses["name"]}" c ON a.course_id = c.course_id '
            f'LIMIT 1000;'
        )

    # PRIORITY 3: Department count
    if students and departments and ("department" in lower or "dept" in lower) and "student" in lower:
        return (
            f'SELECT d.department_name, COUNT(s.student_id) AS student_count '
            f'FROM "{departments["name"]}" d '
            f'LEFT JOIN "{students["name"]}" s ON s.department_id = d.department_id '
            f'GROUP BY d.department_name ORDER BY student_count DESC NULLS LAST LIMIT 1000;'
        )

    # PRIORITY 4: Aggregates
    num_col = next((c for c in primary_table["columns"] if c.get("dataType") in ("BIGINT", "NUMERIC", "INTEGER", "DOUBLE PRECISION") and not c.get("isPrimaryKey")), None)
    text_col = next((c for c in primary_table["columns"] if c.get("dataType") in ("TEXT", "VARCHAR")), None)

    if num_col and text_col:
        if any(w in lower for w in ("avg", "average", "mean")):
            return f'SELECT "{text_col["name"]}", ROUND(AVG("{num_col["name"]}"), 2) AS avg_{num_col["name"]} FROM "{primary_table["name"]}" GROUP BY "{text_col["name"]}" ORDER BY avg_{num_col["name"]} DESC NULLS LAST LIMIT 1000;'
        if any(w in lower for w in ("sum", "total")):
            return f'SELECT "{text_col["name"]}", SUM("{num_col["name"]}") AS total_{num_col["name"]} FROM "{primary_table["name"]}" GROUP BY "{text_col["name"]}" ORDER BY total_{num_col["name"]} DESC NULLS LAST LIMIT 1000;'

    if text_col and any(w in lower for w in ("count", "how many")):
        return f'SELECT "{text_col["name"]}", COUNT(*) AS total_count FROM "{primary_table["name"]}" GROUP BY "{text_col["name"]}" ORDER BY total_count DESC LIMIT 1000;'

    return f'SELECT * FROM "{primary_table["name"]}" LIMIT 1000;'


async def generate_sql(question: str, tables: list, previous_sql: str = None, errors: list = None) -> str:
    """Main SQL generation function with LLM + deterministic fallback"""
    schema_str = format_schema_for_prompt(tables)

    if previous_sql and errors:
        prompt = f"""CRITICAL: Output ONLY valid SQL. NO text, NO explanation.

Database Schema:
{schema_str}

Question: "{question}"

Previous Query Failed:
{previous_sql}

Errors:
{chr(10).join(errors)}

OUTPUT ONLY A VALID POSTGRESQL SELECT QUERY. NOTHING ELSE.
START WITH SELECT. END WITH SEMICOLON."""
    else:
        prompt = f"""You are an expert PostgreSQL developer. Your ONLY job is to generate highly accurate SQL queries based on the provided schema.

Database Schema:
{schema_str}

User Request: "{question}"

CRITICAL INSTRUCTIONS:
1. Output ONLY a valid PostgreSQL SELECT query. No explanations, no markdown blocks (like ```sql).
2. Start the query exactly with "SELECT " and end it with a semicolon ";".
3. Use exact table names and column names as specified in the schema. Wrap table and column names in double quotes if they contain uppercase letters or spaces (e.g. "student_list").
4. If a user asks for a list or overview, select * or the most relevant columns from the main table.
5. If the request involves multiple concepts, use appropriate JOINs.
6. Apply LIMIT 1000 to all queries unless specified otherwise.
7. Use ILIKE for case-insensitive text matching when filtering by names or words.

Output ONLY the SQL code:"""

    raw = await LLMService.generate(prompt, temperature=0.1)
    if raw:
        return clean_sql_output(raw)

    # Fallback to deterministic
    return generate_deterministic_sql(question, tables)
