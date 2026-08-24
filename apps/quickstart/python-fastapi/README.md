# Python (FastAPI)

**What this shows:** the same server/client split from Python — your backend decides the
call, your client renders it — plus verifying the signed session history (transcript +
tool calls) you get afterwards.

There is no Python SDK because the live call is rendered by a browser or native client, so
Python's half is plain HTTP and one dependency.

## Setup

```bash
cp .env.example .env
pip install fastapi uvicorn httpx
uvicorn main:app --reload
```

## What to look at

- `start_call` — the policy is built from your own data. Nothing comes from the request body
  except which character to call.
- The `429` branch — every slot busy is a queue, not a failure.
- `transcript` — the signature is verified over the **raw bytes**. Parsing and re-serializing
  changes the whitespace and it will never match.
- `save_tool_calls` — `tool_calls` rides the same payload and is absent when the session ran
  no tools. Store it beside the turns: a reply grounded in a lookup is only auditable if the
  lookup itself is in the history.

## Cost

Each call bills by the second while live (under $5/hour). Capped at 120s here.
