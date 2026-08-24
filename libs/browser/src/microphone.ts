/**
 * Turning the microphone on, and saying what went wrong when it does not.
 *
 * WHY THIS EXISTS. `room.localParticipant.setMicrophoneEnabled(true)` is one line, so every
 * integration writes it inline and none of them handle its rejection — the reject path is
 * invisible until a real user is on a real machine. When it fails there is nothing to see:
 * the call is already connected, the page is mid-`await`, and the rejection becomes an
 * unhandled promise nobody is looking at. The reported symptom is always the same sentence —
 * "the mic won't start" — and it covers at least six unrelated causes with different fixes,
 * one of which is not in the browser at all.
 *
 * So this returns a RESULT rather than throwing: the cause becomes a value the caller has to
 * handle, and each one carries the sentence that names its actual fix. `message` is what the
 * browser said; `hint` is what the person should do.
 *
 * It is deliberately structural — it never imports `livekit-client`, so it pins no version
 * and adds no bytes. Anything with a `localParticipant.setMicrophoneEnabled` satisfies it.
 */

/** The sliver of livekit-client's `Room` this needs. Structural on purpose — see above. */
export interface MicrophoneCapableRoom {
  localParticipant: {
    setMicrophoneEnabled(enabled: boolean): Promise<unknown>;
  };
}

/**
 * Why the microphone did not start. Every variant has a DIFFERENT fix, which is the whole
 * reason this is an enum and not a boolean.
 */
export type MicrophoneFailureReason =
  /** No `navigator.mediaDevices` — the page is not a secure context. */
  | "insecure-origin"
  /** The permission prompt was never answered. getUserMedia may never settle; we time out. */
  | "no-answer"
  /** The BROWSER denied it — the site's own permission, resettable from the address bar. */
  | "denied-by-browser"
  /** The OS denied it — macOS System Settings, nothing the page or the site can change. */
  | "denied-by-os"
  /** No input device is connected, or none matches the constraints. */
  | "no-device"
  /** A device exists but something else holds it — another tab, app, or a stale call. */
  | "device-in-use"
  /** Anything unrecognised. `message` still carries what the browser said. */
  | "unknown";

export type MicrophoneResult =
  | { ok: true }
  | {
      ok: false;
      reason: MicrophoneFailureReason;
      /** What the browser reported, verbatim. Show it — it is often exact. */
      message: string;
      /** What the person should actually do about it. */
      hint: string;
    };

export interface EnableMicrophoneOptions {
  /**
   * How long to wait before calling it a no-answer. Default 15s.
   *
   * This is not belt-and-braces. Per the getUserMedia specification a prompt the user never
   * dismisses may leave the promise permanently pending — "neither resolve nor reject" — and
   * a page that awaits it in its connect path hangs on a state that has no error and no end.
   * A deadline turns that into a reportable outcome.
   */
  timeoutMs?: number;
}

const HINTS: Record<MicrophoneFailureReason, string> = {
  "insecure-origin":
    "The browser only exposes microphones on a secure origin. Serve the page over https, " +
    "or open it on http://localhost — a LAN address like http://192.168.1.5 will not do.",
  "no-answer":
    "The permission prompt is probably still open, or was dismissed without an answer. " +
    "Look for it in the address bar, answer it, and try again.",
  "denied-by-browser":
    "This site is blocked from using the microphone. Click the icon at the left of the " +
    "address bar, set Microphone to Allow, and reload.",
  "denied-by-os":
    "The operating system is blocking the browser itself, so no site can record. On macOS: " +
    "System Settings > Privacy & Security > Microphone, enable your browser, then RESTART " +
    "it — the change does not apply to a running browser.",
  "no-device":
    "No microphone is available. Connect one, and if you are on Bluetooth headphones check " +
    "they are in a mode that has a microphone.",
  "device-in-use":
    "Another application or browser tab is holding the microphone. Close it — including any " +
    "call from this page you did not hang up — and try again.",
  unknown: "Try again, and if it persists include the message above in your report.",
};

/** Distinguish the OS refusing the browser from the browser refusing the site. */
function isOperatingSystemDenial(message: string): boolean {
  // Chromium says "Permission denied by system" from one path and "System Permissions
  // prevented access to audio capture device" from another; both mean the same thing and
  // both need the same fix, which is not in the browser.
  return /\bby system\b|system permission/i.test(message);
}

function classify(error: unknown): { reason: MicrophoneFailureReason; message: string } {
  // `navigator.mediaDevices` being undefined surfaces as a TypeError on property access,
  // which is the insecure-origin case wearing a confusing name.
  if (error instanceof TypeError && /mediaDevices|undefined/i.test(error.message)) {
    return { reason: "insecure-origin", message: error.message };
  }

  const name = typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
  const message =
    typeof error === "object" && error !== null && "message" in error && error.message
      ? String(error.message)
      : String(error);

  // These names are the DOMException set getUserMedia is specified to reject with; the
  // legacy aliases are what older WebKit and Chromium still emit.
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return {
        reason: isOperatingSystemDenial(message) ? "denied-by-os" : "denied-by-browser",
        message,
      };
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return { reason: "no-device", message };
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return { reason: "device-in-use", message };
    case "SecurityError":
      return { reason: "insecure-origin", message };
    default:
      return { reason: "unknown", message };
  }
}

function fail(reason: MicrophoneFailureReason, message: string): MicrophoneResult {
  return { ok: false, reason, message, hint: HINTS[reason] };
}

/**
 * Publish the caller's microphone, and report WHY if it does not start.
 *
 * ```ts
 * const mic = await enableMicrophone(room);
 * if (!mic.ok) {
 *   status.textContent = `Microphone: ${mic.message}`;
 *   help.textContent = mic.hint;          // the sentence that names the fix
 * }
 * ```
 *
 * Never throws. A call that cannot start the microphone is an ordinary outcome of asking a
 * person for a device, not a programmer error, so it belongs in the return type.
 *
 * Note it does NOT hang up on failure — the call is still live and still billing, and only
 * the caller knows whether a text-only session is useful to them. If it is not, disconnect
 * in the `!ok` branch; leaving a room connected against a device the user never granted is
 * how the retry ends up contending with the call that is still holding it.
 */
export async function enableMicrophone(
  room: MicrophoneCapableRoom,
  options: EnableMicrophoneOptions = {},
): Promise<MicrophoneResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;

  // Checked BEFORE the call: on an insecure origin `navigator.mediaDevices` is undefined and
  // the resulting TypeError names a property, not the reason. Say the reason.
  if (typeof navigator === "undefined" || !navigator.mediaDevices) {
    return fail(
      "insecure-origin",
      "navigator.mediaDevices is undefined — this page is not a secure context.",
    );
  }

  const NO_ANSWER = Symbol("no-answer");
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const deadline = new Promise<typeof NO_ANSWER>((resolve) => {
      timer = setTimeout(() => resolve(NO_ANSWER), timeoutMs);
    });
    const outcome = await Promise.race([
      room.localParticipant.setMicrophoneEnabled(true).then(() => "granted" as const),
      deadline,
    ]);
    if (outcome === NO_ANSWER) {
      return fail(
        "no-answer",
        `The microphone permission prompt was not answered within ${Math.round(timeoutMs / 1000)}s.`,
      );
    }
    return { ok: true };
  } catch (error) {
    const { reason, message } = classify(error);
    return fail(reason, message);
  } finally {
    // The race is settled either way; leaving this armed keeps the page alive in Node-like
    // hosts and fires a dead callback in the browser.
    if (timer !== undefined) clearTimeout(timer);
  }
}
