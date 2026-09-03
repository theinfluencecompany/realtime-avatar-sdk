"""Realtime Avatar from a Python backend: start a call, receive the session history.

    cp .env.example .env && set -a && . ./.env && set +a
    uvicorn main:app --reload

Everything under "your side of the seam" is a stand-in for your own auth and storage, so
the file runs as-is. Replace those; keep the two handlers.
"""

import hashlib
import hmac
import json
import os
import time
from typing import Optional

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

BASE = "https://realtimeavatar.ai/api/v1"
MAX_SKEW_SECONDS = 300

app = FastAPI()
client = httpx.Client(
    base_url=BASE,
    timeout=60.0,
    headers={"Authorization": f"Bearer {os.environ['REALTIME_AVATAR_API_KEY']}"},
)


# ── Your side of the seam ─────────────────────────────────────────────────────
# A real app reads its session cookie in `current_user` and writes to its database in
# the two `save_*` calls. Nothing below this block cares how.


def current_user(request: Request) -> dict:
    """Who is calling. `X-User-Id` stands in for your session cookie."""
    return {"id": request.headers.get("x-user-id", "demo-user")}


def load_character(avatar_id: str) -> dict:
    return {
        "avatar_id": avatar_id,
        "prompt": "You are a warm, unhurried concierge. Answer in one or two spoken sentences.",
    }


HISTORY: dict[str, list] = {}  # user_id -> what was said
TOOL_CALLS: dict[str, list] = {}  # user_id -> what she did
SEEN_SESSIONS: set[str] = set()  # delivery is at-least-once; see `transcript`


def save_turns(user_id: str, segments: list) -> None:
    HISTORY.setdefault(user_id, []).extend(segments)


def save_tool_calls(user_id: str, tool_calls: list) -> None:
    TOOL_CALLS.setdefault(user_id, []).extend(tool_calls)


# ── The two handlers ──────────────────────────────────────────────────────────


class StartCallRequest(BaseModel):
    # The one thing the client may send back: the ticket a 429 handed it. Everything
    # else about the call is decided below, never by the client.
    queue_ticket_id: Optional[str] = None


@app.post("/api/call")
def start_call(req: Optional[StartCallRequest] = None, user=Depends(current_user)):
    """Start a call. The client picks nothing about it — every field here is our decision."""
    character = load_character(os.environ["REALTIME_AVATAR_ID"])

    body = {
        "avatar_id": character["avatar_id"],
        "mode": "voice",
        "stt_mode": "server",
        "instructions": character["prompt"],
        "max_session_seconds": 120,  # an integer, 1..1800 — a forgotten tab cannot run up a bill
        # Echoed back on the transcript so you know whose history it is. Values are strings.
        "client_metadata": {"user_id": str(user["id"])},
        # Where the session history goes when the call ends. The URL must be https and
        # the secret at least 16 characters; it signs every delivery (see `transcript`).
        "transcript_webhook": {
            "url": os.environ["TRANSCRIPT_URL"],
            "secret": os.environ["TRANSCRIPT_SECRET"],
        },
    }
    if req and req.queue_ticket_id:
        body["queue_ticket_id"] = req.queue_ticket_id  # keep our place in line

    r = client.post("/realtime/livekit/session", json=body)

    if r.status_code == 429 and "queue_ticket_id" in r.json():
        # Every slot busy — a queue, not a failure. Relay it whole: the client waits
        # `recommended_retry_ms`, then calls us again with the `queue_ticket_id`. A 429
        # without a ticket is a limit (concurrency or rate), and falls through below.
        return JSONResponse(r.json(), status_code=429)
    if not r.is_success:
        # 402 insufficient_credits, 422 on a bad field, 429 concurrency_limit_reached…
        # The platform's body already names it; relay that rather than a bare 500.
        return JSONResponse(r.json(), status_code=r.status_code)

    # VERBATIM. Wrapping this or adding a key makes the browser client reject it.
    return r.json()


class ReleaseRequest(BaseModel):
    session_id: str


@app.post("/api/call/release")
def release_call(req: ReleaseRequest, user=Depends(current_user)):
    """Free the slot the moment the client hangs up. Free, idempotent, and `reason` is a
    closed set (page_hide · disconnected · superseded · unmount · manual · idle_timeout)."""
    r = client.post(
        "/realtime/livekit/session/release",
        json={"session_id": req.session_id, "reason": "manual"},
    )
    return JSONResponse(r.json(), status_code=r.status_code)


@app.post("/api/transcript")
async def transcript(request: Request):
    """Receive the session history once the call ends: what was said, and what she did."""
    raw = await request.body()  # RAW bytes — do not parse before verifying
    if not _verify(
        raw,
        request.headers.get("x-rta-signature", ""),
        request.headers.get("x-rta-timestamp", ""),
    ):
        raise HTTPException(401)

    payload = json.loads(raw)
    # Delivery is at-least-once: a 5xx or an answer slower than 5 s earns one retry with
    # the same body and signature. Answer fast, and let `session_id` make a repeat harmless.
    session_id = payload["session_id"]
    if session_id in SEEN_SESSIONS:
        return {"ok": True, "duplicate": True}
    SEEN_SESSIONS.add(session_id)

    # `client_metadata` is whatever the mint sent — `{}` when it sent nothing.
    user_id = (payload.get("client_metadata") or {}).get("user_id", "unknown")
    # `interrupted` means she was cut off, so that text is only what she said out loud.
    save_turns(user_id, payload["segments"])
    # Tool calls ride the same payload (absent when the session ran none). Each entry has
    # {name, call_id, arguments, ts} plus — when the model saw an outcome — ok, result|error
    # and duration_ms; no `ok` means the call produced nothing the model saw. Store them
    # beside the turns: a reply grounded in a lookup is only auditable if the lookup is in
    # the history.
    save_tool_calls(user_id, payload.get("tool_calls", []))
    return {"ok": True}


@app.get("/api/history")
def history(user=Depends(current_user)):
    """What this app now knows about the caller — read it back after the call ends."""
    return {
        "turns": HISTORY.get(user["id"], []),
        "tool_calls": TOOL_CALLS.get(user["id"], []),
    }


def _verify(body: bytes, signature: str, timestamp: str) -> bool:
    try:
        if abs(time.time() - int(timestamp)) > MAX_SKEW_SECONDS:
            return False  # replay-bound
    except ValueError:
        return False
    signed = f"{timestamp}.{body.decode()}".encode()
    expected = hmac.new(
        os.environ["TRANSCRIPT_SECRET"].encode(), signed, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(f"v1={expected}", signature)
