// The one entry a server reaches for. Re-exports the zero-dependency core verbatim —
// `libs/http-client` stays the single implementation of the wire, the retry policy, the
// idempotency key and the request timeout.
export * from "../../http-client/src/index.ts";
