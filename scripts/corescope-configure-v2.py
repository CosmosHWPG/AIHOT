"""Copy the explicitly authorized V2 model configuration into this private deployment.

The source database is read-only. Credentials are never written to stdout or tracked files.
Usage: python scripts/corescope-configure-v2.py --v2-root <V2 checkout>
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import secrets
import sqlite3
from urllib.parse import urlparse


def read_env(path: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.removeprefix("export ").split("=", 1)
            result[key.strip()] = value.strip().strip("\"'")
    return result


def configure(v2_root: Path, destination: Path) -> dict[str, object]:
    database = v2_root / "data" / "insight_loop.sqlite3"
    with sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True) as connection:
        connection.execute("PRAGMA query_only=ON")
        connection.row_factory = sqlite3.Row
        row = connection.execute("SELECT * FROM model_processing_config LIMIT 1").fetchone()
        if row is None:
            raise RuntimeError("V2 has no model configuration")
        config = dict(row)
    local = read_env(v2_root / ".env.local")
    key_name = str(config.get("openrouter_api_key_env") or "OPENROUTER_API_KEY")
    model_key = str(config.get("openrouter_api_key") or os.environ.get(key_name) or local.get(key_name) or "")
    embedding_name = str(config.get("embedding_api_key_env") or key_name)
    embedding_key = str(os.environ.get(embedding_name) or local.get(embedding_name) or model_key)
    if config.get("provider") != "openrouter" or not model_key:
        raise RuntimeError("The authorized V2 OpenAI-compatible provider is not configured")
    previous = read_env(destination)
    db_password = previous.get("POSTGRES_PASSWORD") or secrets.token_hex(24)
    values = {
        **previous,
        "SITE_URL": "http://127.0.0.1:8780",
        "WEB_PORT": "8780",
        "API_PORT": "8781",
        "API_BASE_URL": "http://127.0.0.1:8781",
        "DATABASE_URL": f"postgres://corescope:{db_password}@127.0.0.1:5448/corescope",
        "POSTGRES_USER": "corescope",
        "POSTGRES_PASSWORD": db_password,
        "POSTGRES_PORT": "5448",
        "ADMIN_PASSWORD": previous.get("ADMIN_PASSWORD") or secrets.token_urlsafe(18),
        "SESSION_SECRET": previous.get("SESSION_SECRET") or secrets.token_hex(32),
        "IMG_PROXY_SIGN_SECRET": previous.get("IMG_PROXY_SIGN_SECRET") or secrets.token_hex(32),
        "INGEST_TOKEN": previous.get("INGEST_TOKEN") or secrets.token_hex(32),
        "LLM_BASE_URL": str(config.get("openrouter_base_url") or "https://openrouter.ai/api/v1"),
        "LLM_API_KEY": model_key,
        "LLM_MODEL": str(config.get("openrouter_model") or ""),
        # Short structured tasks need the final JSON, not a reasoning-only token budget.
        "LLM_EXTRA_JSON": '{"reasoning":{"enabled":false}}',
        "LLM_JSON_MODE": "true",
        "LLM_VISION": "false",
        "EMBEDDING_BASE_URL": str(config.get("embedding_base_url") or config.get("openrouter_base_url") or ""),
        "EMBEDDING_API_KEY": embedding_key,
        "EMBEDDING_MODEL": str(config.get("embedding_model") or ""),
        "EMBEDDING_DIMS": str(config.get("embedding_dimensions") or 0),
        "V2_ROOT": str(v2_root.resolve()),
        "V2_DATABASE": str(database.resolve()),
        "CORESCOPE_V2_BATCH_LIMIT": "6",
        "CORESCOPE_V2_POLL_SECONDS": "120",
        "MODEL_CALLS_ENABLED": previous.get("MODEL_CALLS_ENABLED", "false"),
        "COLLECT_ENABLED": previous.get("COLLECT_ENABLED", "false"),
        "FEISHU_CONTENT_PUSH_ENABLED": "false",
        "FEISHU_INTERNAL_ENABLED": "false",
        "INDEXNOW_SUBMIT_ENABLED": "false",
        "TRUST_PROXY": "false",
        "NODE_ENV": "production",
        "AIHOT_ENVIRONMENT": "corescope-local",
    }
    if not values["LLM_MODEL"]:
        raise RuntimeError("V2 model name missing")
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Dotenv quotes delimit strings; JSON backslash escapes are not decoded by Node's parser.
    def dotenv_value(value: str) -> str:
        if "\n" in value or "\r" in value:
            raise ValueError("Multiline deployment values are not supported")
        if "'" not in value:
            return "'" + value + "'"
        if '"' not in value:
            return '"' + value + '"'
        raise ValueError("Deployment value has incompatible dotenv quote characters")

    destination.write_text("# Private CoreScope deployment configuration; never commit.\n" + "\n".join(
        f"{name}={dotenv_value(value)}" for name, value in values.items()
    ) + "\n", encoding="utf-8")
    return {"configured": True, "path": str(destination), "provider": config["provider"],
            "model": values["LLM_MODEL"], "embeddingModel": values["EMBEDDING_MODEL"],
            "providerHost": urlparse(values["LLM_BASE_URL"]).hostname, "credentialsPrinted": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--v2-root", type=Path, required=True)
    parser.add_argument("--destination", type=Path, default=Path(__file__).resolve().parents[1] / ".env")
    args = parser.parse_args()
    print(json.dumps(configure(args.v2_root, args.destination), ensure_ascii=False))
