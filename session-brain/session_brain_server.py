#!/usr/bin/env python3
"""
Session Brain (stateful): ingest events from gateway/dispatcher/orchestrator, detect blocks/disconnects/overload,
and optionally ask Gemini for a root-cause summary.

Run (locally):
  pip install fastapi uvicorn requests
  uvicorn session_brain_server:app --host 0.0.0.0 --port 9000

Env (optional):
  GEMINI_API_KEY=...
  GEMINI_MODEL=gemini-2.5-flash
  GEMINI_ENDPOINT=https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
"""
from __future__ import annotations

import os
import time
import json
import sqlite3
from typing import Any, Dict, List, Optional
from collections import deque, defaultdict

import requests
from fastapi import FastAPI
from pydantic import BaseModel, Field

APP_NAME = "session-brain"
DB_PATH = os.environ.get("SB_DB_PATH", "/data/session_brain.sqlite3")

# --- Simple heuristics (tune these) ---
WINDOW_SEC = int(os.environ.get("SB_WINDOW_SEC", "60"))
MAX_429_PER_WINDOW = int(os.environ.get("SB_MAX_429_PER_WINDOW", "20"))
MAX_5XX_PER_WINDOW = int(os.environ.get("SB_MAX_5XX_PER_WINDOW", "15"))
MAX_TIMEOUTS_PER_WINDOW = int(os.environ.get("SB_MAX_TIMEOUTS_PER_WINDOW", "10"))
MAX_LATENCY_P95_MS = int(os.environ.get("SB_MAX_LATENCY_P95_MS", "2500"))
BLOCK_TTL_SEC = int(os.environ.get("SB_BLOCK_TTL_SEC", "900"))

# What "disconnect" looks like varies; allow configuring status codes
DISCONNECT_STATUS = set(
    int(x)
    for x in os.environ.get("SB_DISCONNECT_STATUS", "499,502,503,504").split(",")
    if x.strip()
)

# --- Gemini (optional) ---
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "").strip()
GEMINI_ENDPOINT = os.environ.get(
    "GEMINI_ENDPOINT",
    "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
).strip()

app = FastAPI(title=APP_NAME)


def now_ms() -> int:
    return int(time.time() * 1000)


def ensure_db() -> None:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with sqlite3.connect(DB_PATH) as con:
        con.execute(
            """
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts_ms INTEGER NOT NULL,
          ip TEXT,
          session TEXT,
          endpoint TEXT,
          status INTEGER,
          latency_ms INTEGER,
          backend TEXT,
          error TEXT,
          raw_json TEXT
        )
        """
        )
        con.execute("CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts_ms)")
        con.execute("CREATE INDEX IF NOT EXISTS idx_events_ip ON events(ip)")
        con.execute("CREATE INDEX IF NOT EXISTS idx_events_session ON events(session)")

        con.execute(
            """
        CREATE TABLE IF NOT EXISTS decisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts_ms INTEGER NOT NULL,
          kind TEXT NOT NULL,
          target TEXT NOT NULL,
          ttl_sec INTEGER NOT NULL,
          reason TEXT NOT NULL,
          evidence_json TEXT NOT NULL
        )
        """
        )
        con.execute("CREATE INDEX IF NOT EXISTS idx_decisions_ts ON decisions(ts_ms)")
        con.commit()


ensure_db()


class EventIn(BaseModel):
    ts_ms: Optional[int] = Field(default=None, description="Epoch ms; if omitted server time is used.")
    ip: str
    session: Optional[str] = None
    endpoint: Optional[str] = None
    status: int
    latency_ms: Optional[int] = None
    backend: Optional[str] = None
    error: Optional[str] = None
    meta: Optional[Dict[str, Any]] = None


class AnalyzeIn(BaseModel):
    from_ts_ms: Optional[int] = None
    to_ts_ms: Optional[int] = None
    ip: Optional[str] = None
    session: Optional[str] = None
    limit: int = 3000


# In-memory rolling windows. Persisted history is in SQLite.
ip_windows: Dict[str, deque] = defaultdict(deque)  # (ts_ms, status, latency_ms, endpoint, error)
active_blocks: Dict[str, int] = {}  # ip -> expires_ts_ms


def prune_window(q: deque, cutoff_ts_ms: int) -> None:
    while q and q[0][0] < cutoff_ts_ms:
        q.popleft()


def percentile(values: List[int], p: float) -> Optional[int]:
    if not values:
        return None
    s = sorted(values)
    k = int(round((len(s) - 1) * p))
    return s[max(0, min(k, len(s) - 1))]


def record_event(e: EventIn) -> int:
    ts_ms = e.ts_ms if e.ts_ms is not None else now_ms()
    raw = e.model_dump()
    raw["ts_ms"] = ts_ms
    with sqlite3.connect(DB_PATH) as con:
        cur = con.execute(
            "INSERT INTO events(ts_ms, ip, session, endpoint, status, latency_ms, backend, error, raw_json) VALUES (?,?,?,?,?,?,?,?,?)",
            (
                ts_ms,
                e.ip,
                e.session,
                e.endpoint,
                e.status,
                e.latency_ms,
                e.backend,
                e.error,
                json.dumps(raw, ensure_ascii=False),
            ),
        )
        con.commit()
        return int(cur.lastrowid)


def add_to_windows(e: EventIn) -> None:
    ts_ms = e.ts_ms if e.ts_ms is not None else now_ms()
    item = (ts_ms, e.status, e.latency_ms or -1, e.endpoint or "", e.error or "")
    cutoff = ts_ms - WINDOW_SEC * 1000
    w = ip_windows[e.ip]
    w.append(item)
    prune_window(w, cutoff)


def compute_ip_stats(ip: str) -> Dict[str, Any]:
    w = ip_windows.get(ip)
    if not w:
        return {"ip": ip, "window_sec": WINDOW_SEC, "count": 0}

    statuses = [x[1] for x in w]
    latencies = [x[2] for x in w if x[2] >= 0]

    c429 = sum(1 for s in statuses if s == 429)
    c5xx = sum(1 for s in statuses if 500 <= s <= 599)
    cdisc = sum(1 for s in statuses if s in DISCONNECT_STATUS)
    p95 = percentile(latencies, 0.95) if latencies else None

    return {
        "ip": ip,
        "window_sec": WINDOW_SEC,
        "count": len(w),
        "status_429": c429,
        "status_5xx": c5xx,
        "disconnect_like": cdisc,
        "latency_p95_ms": p95,
    }


def maybe_decide(ip: str) -> Optional[Dict[str, Any]]:
    # skip if already blocked
    exp = active_blocks.get(ip)
    if exp and exp > now_ms():
        return None

    st = compute_ip_stats(ip)
    evidence = {"stats": st}

    reasons = []
    if st.get("status_429", 0) >= MAX_429_PER_WINDOW:
        reasons.append(f"too many 429 in {WINDOW_SEC}s ({st['status_429']})")
    if st.get("status_5xx", 0) >= MAX_5XX_PER_WINDOW:
        reasons.append(f"too many 5xx in {WINDOW_SEC}s ({st['status_5xx']})")
    if st.get("disconnect_like", 0) >= MAX_TIMEOUTS_PER_WINDOW:
        reasons.append(f"too many disconnect/timeout-like statuses in {WINDOW_SEC}s ({st['disconnect_like']})")
    p95 = st.get("latency_p95_ms")
    if p95 is not None and p95 >= MAX_LATENCY_P95_MS:
        reasons.append(f"p95 latency too high ({p95}ms)")

    if not reasons:
        return None

    decision = {
        "ts_ms": now_ms(),
        "kind": "block_ip",
        "target": ip,
        "ttl_sec": BLOCK_TTL_SEC,
        "reason": "; ".join(reasons),
        "evidence": evidence,
    }

    # persist decision + activate block
    with sqlite3.connect(DB_PATH) as con:
        con.execute(
            "INSERT INTO decisions(ts_ms, kind, target, ttl_sec, reason, evidence_json) VALUES (?,?,?,?,?,?)",
            (
                decision["ts_ms"],
                decision["kind"],
                decision["target"],
                decision["ttl_sec"],
                decision["reason"],
                json.dumps(decision["evidence"], ensure_ascii=False),
            ),
        )
        con.commit()

    active_blocks[ip] = decision["ts_ms"] + decision["ttl_sec"] * 1000
    return decision


def call_gemini(prompt: str) -> str:
    if not GEMINI_API_KEY or not GEMINI_MODEL:
        raise RuntimeError("Gemini not configured. Set GEMINI_API_KEY and GEMINI_MODEL.")
    url = GEMINI_ENDPOINT.format(model=GEMINI_MODEL)
    headers = {"x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json"}
    body = {"contents": [{"role": "user", "parts": [{"text": prompt}]}]}
    r = requests.post(url, headers=headers, json=body, timeout=60)
    if r.status_code >= 300:
        raise RuntimeError(f"Gemini error {r.status_code}: {r.text[:1000]}")
    data = r.json()
    try:
        return data["candidates"][0]["content"]["parts"][0]["text"]
    except Exception:
        return json.dumps(data, ensure_ascii=False)


@app.post("/event")
def ingest_event(e: EventIn) -> Dict[str, Any]:
    event_id = record_event(e)
    add_to_windows(e)
    decision = maybe_decide(e.ip)
    return {"ok": True, "event_id": event_id, "decision": decision}


@app.get("/decisions")
def list_decisions(limit: int = 200) -> Dict[str, Any]:
    with sqlite3.connect(DB_PATH) as con:
        rows = con.execute(
            "SELECT ts_ms, kind, target, ttl_sec, reason, evidence_json FROM decisions ORDER BY ts_ms DESC LIMIT ?",
            (limit,),
        ).fetchall()
    out = []
    for r in rows:
        out.append(
            {
                "ts_ms": r[0],
                "kind": r[1],
                "target": r[2],
                "ttl_sec": r[3],
                "reason": r[4],
                "evidence": json.loads(r[5]) if r[5] else {},
            }
        )
    return {"decisions": out}


@app.get("/blocks")
def list_blocks() -> Dict[str, Any]:
    t = now_ms()
    active = {ip: exp for ip, exp in active_blocks.items() if exp > t}
    return {"active_blocks": active, "now_ms": t}


@app.post("/analyze")
def analyze(filters: AnalyzeIn) -> Dict[str, Any]:
    to_ts = filters.to_ts_ms or now_ms()
    from_ts = filters.from_ts_ms or (to_ts - 3600_000)  # default: last hour

    params: List[Any] = [from_ts, to_ts]
    where = "WHERE ts_ms BETWEEN ? AND ?"
    if filters.ip:
        where += " AND ip = ?"
        params.append(filters.ip)
    if filters.session:
        where += " AND session = ?"
        params.append(filters.session)

    q = f"SELECT ts_ms, ip, session, endpoint, status, latency_ms, backend, error FROM events {where} ORDER BY ts_ms ASC LIMIT ?"
    params.append(filters.limit)
    with sqlite3.connect(DB_PATH) as con:
        rows = con.execute(q, params).fetchall()

    events = [
        {
            "ts_ms": r[0],
            "ip": r[1],
            "session": r[2],
            "endpoint": r[3],
            "status": r[4],
            "latency_ms": r[5],
            "backend": r[6],
            "error": r[7],
        }
        for r in rows
    ]

    statuses = [e["status"] for e in events if isinstance(e.get("status"), int)]
    lat = [e["latency_ms"] for e in events if isinstance(e.get("latency_ms"), int)]
    stats = {
        "count": len(events),
        "status_429": sum(1 for s in statuses if s == 429),
        "status_5xx": sum(1 for s in statuses if 500 <= s <= 599),
        "disconnect_like": sum(1 for s in statuses if s in DISCONNECT_STATUS),
        "latency_p95_ms": percentile(lat, 0.95) if lat else None,
    }

    prompt = (
        "You are an SRE assistant. Analyze the following events and explain likely root causes.\n"
        "Return: short summary + key points + suggested actions.\n\n"
        f"Stats: {json.dumps(stats, ensure_ascii=False)}\n"
        f"Events (last {min(len(events), 200)}): {json.dumps(events[-200:], ensure_ascii=False)}\n"
    )

    used_gemini = False
    summary = ""
    key_points: List[str] = []
    suggested_actions: List[str] = []

    if GEMINI_API_KEY and GEMINI_MODEL:
        try:
            used_gemini = True
            text = call_gemini(prompt)
            lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
            summary = "\n".join(lines[:6]) if lines else text
            key_points = [ln.lstrip("-• ").strip() for ln in lines if ln.startswith(("-", "•"))][:12]
            suggested_actions = key_points[:6]
        except Exception:
            used_gemini = False

    if not used_gemini:
        if stats["status_429"] >= 1:
            key_points.append("429 detected: possible rate limiting / protection")
        if stats["status_5xx"] >= 1:
            key_points.append("5xx detected: backend crash/restart/timeout")
        if stats["disconnect_like"] >= 1:
            key_points.append("disconnect-like statuses detected")
        if stats["latency_p95_ms"] and stats["latency_p95_ms"] >= MAX_LATENCY_P95_MS:
            key_points.append("p95 latency high: saturation or downstream slowness")
        summary = " | ".join(key_points) if key_points else "Insufficient signal; widen time range or filter by ip/session."
        suggested_actions = [
            "Lower RPM temporarily for affected sessions",
            "Mark suspect proxy as BAD and switch sessions",
            "Inspect logs around the spike window",
        ]

    return {
        "used_gemini": used_gemini,
        "summary": summary[:2000],
        "key_points": key_points,
        "suggested_actions": suggested_actions,
        "supporting_stats": stats,
    }




