export type RealtimeAvatarApiKeyEnvironment = "live" | "test";

export type ParsedRealtimeAvatarApiKey = {
  readonly raw: string;
  readonly prefix: "tic_live" | "tic_test";
  readonly environment: RealtimeAvatarApiKeyEnvironment;
  readonly keyId: string;
  readonly secret: string;
  readonly redacted: string;
};

export type RealtimeAvatarApiKeyErrorCode =
  | "empty_key"
  | "invalid_prefix"
  | "missing_key_id"
  | "missing_secret"
  | "invalid_format"
  | "revoked_key";

export class RealtimeAvatarApiKeyError extends Error {
  constructor(
    readonly code: RealtimeAvatarApiKeyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RealtimeAvatarApiKeyError";
  }
}

const API_KEY_PATTERN = /^(tic_(live|test))_([A-Za-z0-9]{8,64})_([A-Za-z0-9_-]{24,256})$/;
const TEXT_ENCODER = new TextEncoder();

export function parseRealtimeAvatarApiKey(apiKey: string): ParsedRealtimeAvatarApiKey {
  const raw = apiKey.trim();
  if (!raw) throw new RealtimeAvatarApiKeyError("empty_key", "Realtime Avatar API key is required");

  const match = API_KEY_PATTERN.exec(raw);
  if (match) {
    const prefix = match[1] as "tic_live" | "tic_test";
    const environment = match[2] as RealtimeAvatarApiKeyEnvironment;
    const keyId = match[3];
    const secret = match[4];
    return {
      raw,
      prefix,
      environment,
      keyId,
      secret,
      redacted: redactParts(prefix, keyId, secret),
    };
  }

  if (!raw.startsWith("tic_live_") && !raw.startsWith("tic_test_")) {
    throw new RealtimeAvatarApiKeyError("invalid_prefix", "Realtime Avatar API keys must start with tic_live_ or tic_test_");
  }
  if (/^tic_(?:live|test)__/.test(raw)) {
    throw new RealtimeAvatarApiKeyError("missing_key_id", "Realtime Avatar API key is missing its key id");
  }
  if (/^tic_(?:live|test)_[A-Za-z0-9]{8,64}_?$/.test(raw)) {
    throw new RealtimeAvatarApiKeyError("missing_secret", "Realtime Avatar API key is missing its secret");
  }
  throw new RealtimeAvatarApiKeyError("invalid_format", "Realtime Avatar API key format is invalid");
}

export function redactRealtimeAvatarApiKey(apiKey: string | ParsedRealtimeAvatarApiKey): string {
  const parsed = typeof apiKey === "string" ? parseRealtimeAvatarApiKey(apiKey) : apiKey;
  return parsed.redacted;
}

export function assertRealtimeAvatarApiKeyActive(
  apiKey: string | ParsedRealtimeAvatarApiKey,
  options: { revokedKeyIds?: ReadonlySet<string> | readonly string[] } = {},
): ParsedRealtimeAvatarApiKey {
  const parsed = typeof apiKey === "string" ? parseRealtimeAvatarApiKey(apiKey) : apiKey;
  const revoked = options.revokedKeyIds instanceof Set ? options.revokedKeyIds : new Set(options.revokedKeyIds ?? []);
  if (revoked.has(parsed.keyId)) {
    throw new RealtimeAvatarApiKeyError("revoked_key", "Realtime Avatar API key has been revoked");
  }
  return parsed;
}

export async function hashRealtimeAvatarApiKey(
  apiKey: string,
  options: { pepper?: string | Uint8Array } = {},
): Promise<string> {
  parseRealtimeAvatarApiKey(apiKey);
  const bytes = TEXT_ENCODER.encode(apiKey.trim());
  if (options.pepper) {
    const key = await crypto.subtle.importKey(
      "raw",
      copyBytes(pepperBytes(options.pepper)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, copyBytes(bytes)));
    return `hmac-sha256:${toHex(digest)}`;
  }

  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copyBytes(bytes)));
  return `sha256:${toHex(digest)}`;
}

export async function verifyRealtimeAvatarApiKeyHash(
  apiKey: string,
  expectedHash: string,
  options: { pepper?: string | Uint8Array } = {},
): Promise<boolean> {
  const actualHash = await hashRealtimeAvatarApiKey(apiKey, options);
  return timingSafeEqual(actualHash, expectedHash);
}

function redactParts(prefix: "tic_live" | "tic_test", keyId: string, secret: string): string {
  return `${prefix}_${keyId}...${secret.slice(-4)}`;
}

function pepperBytes(pepper: string | Uint8Array): Uint8Array {
  return typeof pepper === "string" ? TEXT_ENCODER.encode(pepper) : pepper;
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(left: string, right: string): boolean {
  let diff = left.length ^ right.length;
  const maxLength = Math.max(left.length, right.length);
  for (let index = 0; index < maxLength; index += 1) {
    diff |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return diff === 0;
}
