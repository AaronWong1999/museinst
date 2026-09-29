export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("cloudflare:")) {

    const code = [
      "export class DurableObject {",
      "  constructor(ctx, env) { this.ctx = ctx; this.env = env; }",
      "}",
      "export class WorkerEntrypoint {",
      "  constructor(ctx, env) { this.ctx = ctx; this.env = env; }",
      "}",
      "export const WebSocketPair = class WebSocketPair {};",
      "export const awaitScheduledTasks = async () => {};",
      "export const connect = (...args) => globalThis.__mockSocketConnect ? globalThis.__mockSocketConnect(...args) : null;",
      "export default {};",
    ].join("\n");
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(code),
    };
  }
  return nextResolve(specifier, context);
}
