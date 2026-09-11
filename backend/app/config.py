import os
from dotenv import load_dotenv

# Load .env from the backend directory (one level up from app/)
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), '..', '.env'))

class Settings:
    # App
    NODE_ENV: str = os.getenv("NODE_ENV", "development")
    APP_URL: str = os.getenv("APP_URL", "http://localhost:5173")

    # Database
    DATABASE_URL: str = os.getenv("DATABASE_URL", "")

    # AI / LLM
    GEMINI_API_KEY: str = os.getenv("GEMINI_API_KEY", "")
    # Normalize model name — gemini-3.8-flash doesn't exist; use gemini-2.0-flash
    _raw_model: str = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")
    GEMINI_MODEL: str = _raw_model if _raw_model not in ("gemini-3.8-flash", "gemini-3.6-flash") else "gemini-2.0-flash"
    LLM_PROVIDER: str = os.getenv("LLM_PROVIDER", "gemini")
    OLLAMA_MODEL: str = os.getenv("OLLAMA_MODEL", "mistral")
    OLLAMA_BASE_URL: str = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
    TOGETHER_API_KEY: str = os.getenv("TOGETHER_API_KEY", "")
    TOGETHER_MODEL: str = os.getenv("TOGETHER_MODEL", "mistralai/Mistral-7B-Instruct-v0.1")
    OPENROUTER_API_KEY: str = os.getenv("OPENROUTER_API_KEY", "")
    OPENROUTER_MODEL: str = os.getenv("OPENROUTER_MODEL", "mistralai/mistral-7b-instruct")

    # Limits
    MAX_CSV_BYTES: int = int(os.getenv("MAX_CSV_BYTES", "26214400"))
    MAX_CSV_ROWS: int = int(os.getenv("MAX_CSV_ROWS", "100000"))
    MAX_CSV_COLUMNS: int = int(os.getenv("MAX_CSV_COLUMNS", "200"))
    MAX_RESULT_ROWS: int = int(os.getenv("MAX_RESULT_ROWS", "1000"))
    MAX_RESULT_BYTES: int = int(os.getenv("MAX_RESULT_BYTES", "5242880"))
    QUERY_TIMEOUT_MS: int = int(os.getenv("QUERY_TIMEOUT_MS", "15000"))
    MAX_SQL_CORRECTIONS: int = int(os.getenv("MAX_SQL_CORRECTIONS", "3"))
    PREVIEW_TTL_SECONDS: int = int(os.getenv("PREVIEW_TTL_SECONDS", "900"))

    # Auth
    SESSION_COOKIE_NAME: str = "claritysql_session"
    SESSION_TTL_HOURS: int = 72
    SECRET_KEY: str = os.getenv("SECRET_KEY", "claritysql-secret-key-change-in-prod!")

settings = Settings()
