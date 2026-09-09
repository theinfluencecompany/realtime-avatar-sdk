export type VideoSupport =
  | { supported: true }
  | { supported: false; reason: "webrtc_unavailable" | "codec_unavailable"; message: string };

/** Check before starting a billed video session; this does not prove negotiated playback. */
export function checkVideoSupport(codec = "h264"): VideoSupport {
  if (typeof RTCRtpReceiver === "undefined") {
    return { supported: false, reason: "webrtc_unavailable", message: "This browser does not support realtime media." };
  }
  const codecs = RTCRtpReceiver.getCapabilities("video")?.codecs ?? [];
  if (!codecs.some((entry) => entry.mimeType.toLowerCase() === `video/${codec.toLowerCase()}`)) {
    return { supported: false, reason: "codec_unavailable", message: `This browser cannot receive ${codec.toUpperCase()} video. Use a browser with that codec before starting a video call.` };
  }
  return { supported: true };
}
