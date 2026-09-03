"""Create an avatar from Python: portrait in, character out, then direct how she rests.

    export REALTIME_AVATAR_API_KEY=tic_...
    python3 create_avatar.py portrait.png "Rin"

Plain HTTP, one dependency. Every call here is what the docs' Python tabs show, run in order:
register the portrait, create the avatar, wait for `ready`, read the clip library, re-direct
the resting loop and wait for the swap.
"""

import os
import sys
import time

import httpx

client = httpx.Client(
    base_url="https://realtimeavatar.ai/api/v1",
    timeout=60.0,
    headers={"Authorization": f"Bearer {os.environ['REALTIME_AVATAR_API_KEY']}"},
)


def wait_until(describe: str, fetch, done, every: float = 15, cap: float = 900) -> dict:
    """Poll `fetch()` until `done(body)`; print each change; give up after `cap` seconds."""
    t0, last = time.monotonic(), None
    while True:
        body = fetch()
        key = describe.format(**body)
        if key != last:
            print(f"  [{time.monotonic() - t0:4.0f}s] {key}")
            last = key
        if done(body):
            return body
        if time.monotonic() - t0 > cap:
            sys.exit(f"gave up after {cap:.0f}s: {key}")
        time.sleep(every)


def main(portrait_path: str, display_name: str) -> int:
    # 1. The portrait. Bytes you hold go up as multipart; a URL you host goes to /assets/remote.
    with open(portrait_path, "rb") as fh:
        asset = client.post("/assets", files={"file": fh}, data={"kind": "image"}).json()
    print(f"asset {asset['id']} — {asset['publicUrl']}")

    # 2. The avatar. 201 comes back in under a second with status "preprocessing"; the loop
    #    and the clip library render in the background.
    r = client.post(
        "/avatars",
        json={
            "displayName": display_name,
            "sourceAssetId": asset["id"],
            "voice": {"auto_description": "Warm, clear, mid-pitch — natural and conversational."},
        },
    )
    if not r.is_success:
        sys.exit(f"create refused: {r.status_code} {r.text}")
    avatar = r.json()
    print(f"avatar {avatar['id']} — status {avatar['status']}")

    # 3. Wait for `ready`. Gate on status / idleVideoStatus, never on sourceKind: it flips to
    #    "video" the moment the generated loop attaches.
    avatar = wait_until(
        "status={status} idleVideoStatus={idleVideoStatus} sourceKind={sourceKind}",
        lambda: client.get(f"/avatars/{avatar['id']}").json(),
        lambda a: a["status"] in ("ready", "failed"),
    )
    if avatar["status"] != "ready":
        sys.exit(f"avatar failed: {avatar.get('error')}")

    # 4. The clip library she was created with. `revision` sits beside `data` — it is what a
    #    later PUT /avatars/{id}/clips passes as expectedRevision.
    library = client.get(f"/avatars/{avatar['id']}/clips").json()
    print(f"clip library revision {library['revision']}:")
    for clip in library["data"]:
        print(f"  {clip['role']:<8} {clip['clipId']:<28} {clip['status']:<10} {clip.get('whenHint') or ''}")

    # 5. Direct how she rests. 202; she keeps serving the previous loop (`servingUrl`) for the
    #    whole render, then the swap publishes at once. A second re-direct while one is in
    #    flight is 409 loop_pending.
    r = client.put(
        f"/avatars/{avatar['id']}/loop",
        json={"motionPrompt": "tilts her head, a small amused smile, settles back to centre"},
    )
    if r.status_code != 202:
        sys.exit(f"loop re-direct refused: {r.status_code} {r.text}")
    accepted = r.json()
    print(f"loop re-direct accepted; still serving {accepted['servingUrl']}")
    avatar = wait_until(
        "status={status} idleVideoStatus={idleVideoStatus}",
        lambda: client.get(f"/avatars/{avatar['id']}").json(),
        lambda a: a["idleVideoStatus"] in ("ready", "failed"),
        cap=720,
    )
    # `sourceAssetId` now names the loop she serves — a new asset, not the one in servingUrl.
    print(f"new loop {'live' if avatar['idleVideoStatus'] == 'ready' else 'FAILED'}: asset {avatar['sourceAssetId']}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    sys.exit(main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "Rin"))
