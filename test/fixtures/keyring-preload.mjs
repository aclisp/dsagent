import { registerHooks } from "node:module";

// Replace only the OS keyring boundary; DSCode and Pi run unmodified in the CLI.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== "@napi-rs/keyring") return nextResolve(specifier, context);
    return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`
      export class Entry {
        constructor(service, account) {
          this.matches = service === "ai.aclisp.dscode" && account === "deepseek";
        }
        getPassword() {
          return this.matches ? JSON.stringify({ type: "api_key", key: "keyring-only-test-key" }) : null;
        }
      }
    `)}` };
  },
});
