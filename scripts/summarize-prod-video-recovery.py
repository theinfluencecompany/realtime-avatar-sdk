import json
from pathlib import Path

import sys

ROOT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path("/tmp/rta-prod-video-recovery")


def percentile(values, percentile):
    if not values:
        return None
    return round(sorted(values)[round((len(values) - 1) * percentile)], 2)


def summarize(path):
    raw = json.loads(path.read_text())
    if raw.get("verdict") != "captured":
        return {"name": raw["name"], "verdict": raw.get("verdict")}
    events = {event["label"]: event["t"] for event in raw["events"]}
    restored = events["network-restored"]
    slow_start = events["slow-start"]
    frames = raw["frames"]
    last = min(raw["measurementEnd"], frames[-1]["t"])
    layers = raw["caps"][0]["layers"]
    top = max(layers, key=lambda layer: layer["width"] * layer["height"])
    is_top = lambda frame: frame["width"] * frame["height"] >= top["width"] * top["height"]
    spans = []
    top_start = None
    for frame in frames:
        if frame["t"] < restored:
            continue
        if is_top(frame):
            if top_start is None:
                top_start = frame["t"]
        elif top_start is not None:
            spans.append((top_start, frame["t"]))
            top_start = None
    if top_start is not None:
        spans.append((top_start, last))
    sustained = next((a for a, b in spans if b - a >= 5000), None)
    first_top = next((f["t"] for f in frames if f["t"] >= restored and is_top(f)), None)
    stable_to_end = next((a for a, b in spans if b == last and b - a >= 5000), None)
    inbound = [
        {"t": sample["t"], **row}
        for sample in raw["stats"]
        for row in sample["rows"]
        if row["type"] == "inbound-rtp" and row.get("kind") == "video"
    ]

    def window(start, end):
        duration = end - start
        top_ms = 0
        presented = 0
        for left, right in zip(frames, frames[1:]):
            overlap = max(0, min(right["t"], end) - max(left["t"], start))
            if overlap == 0:
                continue
            if is_top(left):
                top_ms += overlap
            delta = right["presentedFrames"] - left["presentedFrames"]
            dt = right["t"] - left["t"]
            if 0 <= delta <= dt / 1000 * 120:
                presented += delta * overlap / dt
        samples = [sample for sample in inbound if start <= sample["t"] <= end]
        values = [frame for frame in frames if start <= frame["t"] <= end]
        delays = [
            frame["expectedDisplayTime"] - frame["receiveTime"]
            for frame in values
            if frame.get("receiveTime") is not None
        ]
        result = {
            "seconds": round(duration / 1000, 2),
            "topResolutionShare": round(top_ms / duration, 4),
            "presentedFps": round(presented / duration * 1000, 2),
            "receiveToDisplayMedianMs": percentile(delays, 0.5),
            "receiveToDisplayP95Ms": percentile(delays, 0.95),
        }
        if len(samples) > 1:
            first, final = samples[0], samples[-1]
            time_s = (final["t"] - first["t"]) / 1000
            for field in ["packetsLost", "packetsReceived", "freezeCount", "totalFreezesDuration", "framesDecoded", "framesDropped"]:
                result[field] = round(final.get(field, 0) - first.get(field, 0), 4)
            result["receivedKbps"] = round((final["bytesReceived"] - first["bytesReceived"]) * 8 / time_s / 1000, 1)
        return result

    actual_freeze_rows = [
        {"t": round((tick["t"] - restored) / 1000, 2), "freezeMs": tick["signal"]["freezeMsInWindow"]}
        for tick in raw["ticks"]
        if tick["t"] >= restored and tick["signal"]["freezeMsInWindow"] > 0
    ]
    at_10 = next((frame for frame in frames if frame["t"] >= restored + 10000), None)
    trace = []
    for second in range(int((last - restored) / 1000)):
        start = restored + second * 1000
        row = window(start, start + 1000)
        frame = next((f for f in frames if f["t"] >= start), None)
        trace.append({"second": second, "width": frame["width"] if frame else None,
                      "height": frame["height"] if frame else None, **row})
    return {
        "name": raw["name"], "arm": raw["arm"], "startedAt": raw["startedAt"],
        "verdict": raw["verdict"], "browser": raw["browserVersion"],
        "pool": raw.get("grant", {}).get("capacityPool"),
        "bundleSha256": raw["deployedBundleSha256"],
        "candidateCoreSha256": raw["candidateCoreSha256"],
        "surfaceSourceSha256": raw.get("surfaceSourceSha256"),
        "conditions": raw["conditions"],
        "topResolution": {"width": top["width"], "height": top["height"]},
        "at10s": {"width": at_10["width"], "height": at_10["height"]} if at_10 else None,
        "firstPresentedFrameAfterClickMs": round(raw["firstFrame"] - events["call-click"], 2),
        "firstTopAfterRestoreSeconds": round((first_top - restored) / 1000, 2) if first_top else None,
        "fiveSecondTopRunAfterRestoreSeconds": round((sustained - restored) / 1000, 2) if sustained else None,
        "stayedTopUntilEndAfterRestoreSeconds": round((stable_to_end - restored) / 1000, 2) if stable_to_end else None,
        "topSpansAfterRestoreSeconds": [[round((a-restored)/1000, 2), round((b-restored)/1000, 2)] for a, b in spans],
        "observedRecoveryWindowSeconds": round((last - restored) / 1000, 2),
        "beforeSlow": window(raw["firstFrame"], slow_start),
        "duringSlow": window(slow_start, restored),
        "afterRestore": window(restored, last),
        "last20s": window(last - 20000, last),
        "postRestoreFreezeSignals": actual_freeze_rows,
        "longTaskCount": len(raw["longTasks"]),
        "longTaskMs": round(sum(task["duration"] for task in raw["longTasks"]), 1),
        "patchesServed": raw["patchesServed"],
        "cleanup": raw["cleanup"], "pageErrors": raw["errors"],
        "recordedMedia": Path(raw["mediaVideo"]).name if raw.get("mediaVideo") else None,
        "recordingRestoreOffsetSeconds": round((restored - raw["recordingStartT"]) / 1000, 3) if raw.get("recordingStartT") else None,
        "timeline": trace,
    }


if __name__ == "__main__":
    runs = [summarize(path) for path in sorted(ROOT.glob("*/result.json"))]
    (ROOT / "summary.json").write_text(json.dumps({"runs": runs}, indent=2) + "\n")
    for run in runs:
        print(json.dumps({key: value for key, value in run.items() if key not in ["timeline", "postRestoreFreezeSignals", "conditions"]}))
