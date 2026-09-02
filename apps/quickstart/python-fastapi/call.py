"""Call her from Python: mint through main.py, join the room, send a turn, listen, hang up.

    pip install livekit httpx
    python3 call.py "Where is a good coffee near the hotel?"

The browser is the usual client. This is the same seam driven from a terminal — a test,
a bot, a server-side rehearsal — and it ends the way a client should: it releases the
slot, then reads back the history the transcript webhook delivered. main.py must be
running with a public TRANSCRIPT_URL (see README).
"""

import asyncio
import os
import sys
import time

import httpx
from livekit import rtc

APP_URL = os.environ.get("APP_URL", "http://localhost:8000")
USER_ID = os.environ.get("USER_ID", "demo-user")
CHAT_TOPIC = "lk.chat"  # what the avatar listens to; what `useChat().send()` uses
TRANSCRIPT_TOPIC = "lk.transcription"  # what she says, as text, as she says it


async def main(text: str) -> int:
    app = httpx.Client(base_url=APP_URL, timeout=30.0, headers={"x-user-id": USER_ID})
    t0 = time.monotonic()
    since = lambda: f"[{time.monotonic() - t0:5.1f}s]"

    # 1. Ask OUR backend for a call. The grant comes back verbatim; a full pool is a 429
    #    that carries a ticket — send it back and the retry keeps its place in line.
    ticket = None
    while True:
        r = app.post("/api/call", json={"queue_ticket_id": ticket} if ticket else {})
        body = r.json()
        if r.status_code == 429 and "queue_ticket_id" in body:
            ticket = body["queue_ticket_id"]
            wait_ms = body.get("recommended_retry_ms", 1000)
            print(f"{since()} queued at position {body.get('queue_position')}; retrying in {wait_ms} ms")
            await asyncio.sleep(wait_ms / 1000)
            continue
        if not r.is_success:
            print(f"{since()} refused: {r.status_code} {body}")
            return 1
        grant = body
        break
    print(f"{since()} granted session {grant['session_id']} in room {grant['room_name']}")

    # 2. Join the room the grant names and wait for her audio.
    room = rtc.Room()
    she_is_here = asyncio.Event()
    heard: list[str] = []

    @room.on("track_subscribed")
    def _on_track(track, publication, participant):
        if track.kind == rtc.TrackKind.KIND_AUDIO:
            print(f"{since()} she is on the line ({participant.identity})")
            she_is_here.set()

    def _on_transcription(reader, participant_identity):
        # Her words arrive as text streams while she speaks: partial segments first, then
        # the final one (`lk.transcription_final`). Only finals count as "she answered".
        async def read():
            try:
                said = (await reader.read_all()).strip()
            except rtc.data_stream.StreamError:
                return  # we hung up mid-stream
            final = reader.info.attributes.get("lk.transcription_final") == "true"
            if said and final and participant_identity != room.local_participant.identity:
                heard.append(said)
                print(f"{since()}   she: {said}")

        asyncio.ensure_future(read())

    room.register_text_stream_handler(TRANSCRIPT_TOPIC, _on_transcription)
    await room.connect(grant["livekit_url"], grant["participant_token"])
    print(f"{since()} connected as {room.local_participant.identity}")
    try:
        await asyncio.wait_for(she_is_here.wait(), timeout=45)
    except asyncio.TimeoutError:
        print(f"{since()} no avatar audio within 45 s")
        await room.disconnect()
        return 2

    # She opens the call herself. Let that line land (or 8 s pass) before you type — a turn
    # sent while she is still settling in is a turn sent into her greeting.
    opened = time.monotonic()
    while not heard and time.monotonic() - opened < 8:
        await asyncio.sleep(0.25)
    before = len(heard)

    # 3. One turn, typed. The attribute is the per-turn steer main.py's docs describe:
    #    it shapes THIS answer only and is never spoken.
    await room.local_participant.send_text(
        text, topic=CHAT_TOPIC, attributes={"rta.turn_instructions": "One or two spoken sentences."}
    )
    print(f"{since()}   you: {text}")

    # 4. Listen until she has answered: a real line after yours (she may fill the pause with
    #    a short "mm?" first), then 5 s with nothing new — or 45 s.
    deadline = time.monotonic() + 45
    quiet_since = None
    last_n = before
    while time.monotonic() < deadline:
        await asyncio.sleep(0.5)
        if len(heard) != last_n:
            last_n, quiet_since = len(heard), time.monotonic()
        answered = any(len(line) > 12 for line in heard[before:])
        if answered and quiet_since and time.monotonic() - quiet_since > 5:
            break

    # 5. Hang up like a client should: leave the room, then free the slot early.
    await room.disconnect()
    rel = app.post("/api/call/release", json={"session_id": grant["session_id"]})
    print(f"{since()} released: {rel.status_code} {rel.json()}")

    # 6. The history arrives at main.py's /api/transcript once the session ends. Read it back.
    for _ in range(60):
        await asyncio.sleep(2)
        h = app.get("/api/history").json()
        if h["turns"]:
            print(f"{since()} transcript delivered: {len(h['turns'])} segment(s), {len(h['tool_calls'])} tool call(s)")
            for seg in h["turns"]:
                print(f"    {seg.get('role', '?'):>9}: {seg.get('text', '')[:120]}")
            return 0
    print(f"{since()} no transcript delivered within 120 s")
    return 3


if __name__ == "__main__":
    sys.exit(asyncio.run(main(" ".join(sys.argv[1:]) or "Where is a good coffee near the hotel?")))
