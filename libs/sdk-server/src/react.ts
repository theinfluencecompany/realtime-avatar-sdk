// The browser half. NOTHING here is ever handed an API key.
//
// It is a SUBPATH rather than a separate npm name, and the guard is mechanical rather than
// social: every key-holding entry of this package carries `browser` and `react-native` export
// conditions pointing at src/server-only-guard.ts, so a client bundle physically cannot pull the
// server module in. Measured — a secret marker appears 0 times in an esbuild browser bundle and 1
// time in the node control. The previous shape put this file under its own npm name on the theory
// that a condition "chooses WHICH file is bundled, never WHETHER"; that was tested and is false.
export * from "../../client/src/react/index";
