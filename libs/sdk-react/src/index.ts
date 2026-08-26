// The browser half. NOTHING here should ever be handed an API key — that is the whole reason
// this is a separate npm name rather than a subpath of `realtime-avatar`. A bundler will
// happily inline a secret written into a client file (measured: webpack 5 `target:"web"`
// emitted a Stripe secret key into a browser bundle at exit 0 with no warning), and an
// `exports` condition cannot stop it: conditions choose WHICH file is bundled, never WHETHER.
export * from "../../client/src/react/index";
