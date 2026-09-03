# Python (FastAPI)

**What this shows:** the same server/client split from Python — your backend decides the
call, your client renders it — plus receiving and verifying the signed session history
(transcript + tool calls) afterwards. And, because a client does not have to be a browser,
a terminal client that joins the room from Python and talks to her.

There is no Python SDK because the live call is rendered by a browser or native client, so
Python's half is plain HTTP and one dependency.

## Files

| File | What it is |
| --- | --- |
| `main.py` | The backend: `POST /api/call` mints a call from **your** policy, `POST /api/call/release` frees the slot, `POST /api/transcript` receives the signed history, `GET /api/history` reads it back. Runs as-is; the stand-ins at the top are where your auth and storage go. |
| `call.py` | A client, from a terminal: asks `main.py` for a call, joins the LiveKit room, types one turn, prints what she says, hangs up, and reads the delivered transcript back. |
| `create_avatar.py` | The other half of the API from Python: upload a portrait, create an avatar, wait for it, read its clip library, re-direct its resting loop. |

## Setup

```bash
cp .env.example .env            # key, avatar id, transcript URL + secret
pip install -r requirements.txt
set -a && . ./.env && set +a
uvicorn main:app --reload
```

The transcript webhook needs a public **https** URL for `/api/transcript`. Locally:

```bash
cloudflared tunnel --url http://localhost:8000     # prints https://<something>.trycloudflare.com
# TRANSCRIPT_URL=https://<something>.trycloudflare.com/api/transcript
```

Then, from a second terminal:

```bash
python3 call.py "Where is a good coffee near the hotel?"
```

A run against production, end to end from Python, looked like this:

```
[  2.8s] granted session fbf1be3d-… in room voice-fbf1be3d-…
[  3.3s] she is on the line (agent-AJ_56EPQMiFTXU5)
[  7.3s]   she: I was just watching the light catch the dust motes in the library, waiting for you to join me.
[  7.3s]   you: Where is a good coffee near the hotel?
[  7.8s]   she: mm?
[ 21.2s]   she: There is a quiet little roastery just around the corner that serves a perfect pour-over …
[ 26.7s] released: 200 {'ok': True}
[ 30.7s] transcript delivered: 3 segment(s), 0 tool call(s)
    assistant: I was just watching the light catch the dust motes in the library, waiting for you to join me.
         user: Where is a good coffee near the hotel?
    assistant: There is a quiet little roastery just around the corner that serves a perfect pour-over …
```

The typed turn and both of her lines are in the delivered history, in order, and the
signature over the raw bytes verified with the `_verify` in `main.py`.

## What to look at

- `start_call` — the policy is built from your own data. Nothing comes from the request body
  except, on a retry, the queue ticket a 429 handed out.
- The `429` branch — every slot busy is a queue, not a failure. Relay the body **whole**: the
  client needs `queue_ticket_id` (to keep its place) and `recommended_retry_ms` (when to ask
  again). A 429 *without* a ticket is a limit — concurrency or rate — and is relayed like any
  other refusal.
- Every other refusal (`402 insufficient_credits`, a `422` on a bad field) is relayed with the
  platform's own body and status. `raise_for_status()` here would turn each into a bare 500.
- The mint carries `transcript_webhook` (where the history goes; https, secret ≥ 16 chars) and
  `client_metadata` (echoed back so you know whose history it is; string values only).
- `transcript` — the signature is verified over the **raw bytes**. Parsing and re-serializing
  changes the whitespace and it will never match. Delivery is at-least-once: a 5xx or an
  answer slower than 5 s earns one retry with the same body and signature, so answer fast and
  dedupe on `session_id`. `client_metadata` is `{}` when the mint sent none — never index into
  it blindly.
- `save_tool_calls` — `tool_calls` rides the same payload and is absent when the session ran
  no tools. Store it beside the turns: a reply grounded in a lookup is only auditable if the
  lookup itself is in the history.
- In `call.py`: the turn goes out as a text stream on the `lk.chat` topic — the same thing
  `useChat().send()` does in the browser — and `rta.turn_instructions` on it is a per-turn
  steer that shapes that one answer and is never spoken. Her words come back as text streams
  on `lk.transcription`; only the ones marked `lk.transcription_final` are whole lines.
- `create_avatar.py`: `POST /avatars` answers `201` with `status: "preprocessing"` within a
  second; `ready` follows in a minute or two. Once the generated loop attaches, `sourceKind`
  reads `"video"` — gate on `status` / `idleVideoStatus`, never on `sourceKind`. The clip
  library's `revision` is a top-level field of `GET /avatars/{id}/clips`, beside `data`.
  Declaring clips (`PUT /avatars/{id}/clips`) is a per-tenant rollout and answers
  `403 clip_library_not_enabled` until yours is on; re-directing the loop
  (`PUT /avatars/{id}/loop`) is open to every avatar with a portrait.

## Cost

Each call bills by the second while live (under $5/hour). Capped at 120s here. Creating an
avatar and re-directing its loop are each billed as one generation.
