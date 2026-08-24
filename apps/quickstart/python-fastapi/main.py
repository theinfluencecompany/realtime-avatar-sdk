"""Realtime Avatar from a Python backend: start a call, receive the session history."""

import hashlib
import hmac
import json
import os
import time

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

BASE = "https://realtimeavatar.ai/api/v1"
MAX_SKEW_SECONDS = 300

app = FastAPI()
client = httpx.Client(
    base_url=BASE,
    timeout=60.0,
    headers={"Authorization": f"Bearer {os.environ['REALTIME_AVATAR_API_KEY']}"},
)


@app.post("/api/call")
def start_call(user=Depends(current_user)):
    """Start a call. The client picks nothing about it — every field here is our decision."""
    character = load_character(os.environ["REALTIME_AVATAR_ID"])

    body = {
        "avatar_id": character["avatar_id"],
        "mode": "voice",
        "stt_mode": "server",
        "instructions": character["prompt"],
        "max_session_seconds": 120,          # a forgotten tab cannot run up a bill
        "client_metadata": {"user_id": user["id"]},
        "transcript_webhook": {
            "url": "https://your.app/api/transcript",
            "secret": os.environ["TRANSCRIPT_SECRET"],
        },
    }

    r = client.post("/realtime/livekit/session", json=body)

    if r.status_code == 429:                  # every slot busy — a queue, not a failure
        q = r.json()
        return JSONResponse(
            {"queued": True, "position": q.get("queue_position")}, status_code=429
        )
    if r.status_code == 402:
        raise HTTPException(402, {"code": "insufficient_credits"})
    r.raise_for_status()

    # VERBATIM. Wrapping this or adding a key makes the browser client reject it.
    return r.json()


@app.post("/api/transcript")
async def transcript(request: Request):
    """Receive the session history once the call ends: what was said, and what she did."""
    raw = await request.body()               # RAW bytes — do not parse before verifying
    if not _verify(raw, request.headers.get("x-rta-signature", ""),
                   request.headers.get("x-rta-timestamp", "")):
        raise HTTPException(401)

    payload = json.loads(raw)
    user_id = payload["client_metadata"]["user_id"]
    # `interrupted` means she was cut off, so that text is only what she said out loud.
    save_turns(user_id, payload["segments"])
    # Tool calls ride the same payload (absent when the session ran none). Each entry has
    # {name, call_id, arguments, ts} plus — when the model saw an outcome — ok, result|error
    # and duration_ms; no `ok` means the call produced nothing the model saw. Store them
    # beside the turns: a reply grounded in a lookup is only auditable if the lookup is in
    # the history.
    save_tool_calls(user_id, payload.get("tool_calls", []))
    return {"ok": True}


def _verify(body: bytes, signature: str, timestamp: str) -> bool:
    try:
        if abs(time.time() - int(timestamp)) > MAX_SKEW_SECONDS:
            return False                     # replay-bound
    except ValueError:
        return False
    signed = f"{timestamp}.{body.decode()}".encode()
    expected = hmac.new(
        os.environ["TRANSCRIPT_SECRET"].encode(), signed, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(f"v1={expected}", signature)
