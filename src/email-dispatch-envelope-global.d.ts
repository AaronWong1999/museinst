// Temporary ambient bridge for worker.ts, which references EmailDispatchEnvelope in
// the Queue handler without importing the exported Env type. Keep this alias single-
// sourced from env.ts so the runtime contract cannot drift.
type EmailDispatchEnvelope = import("./env").EmailDispatchEnvelope;
