import { afterEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("standalone distribution defaults", () => {
  it("resolves command tools from the current DSCode home instead of pi's import-time home", async () => {
    vi.stubGlobal("DSCODE_STANDALONE", true);
    const home = path.join(os.tmpdir(), "dscode-custom-home");
    vi.stubEnv("DSCODE_HOME", home);
    vi.resetModules();
    const { withPiManagedBinPath } = await import("../packages/core/src/process.ts");
    const environment = { PATH: os.tmpdir() };
    expect(withPiManagedBinPath(environment).PATH).toBe([path.join(home, "bin"), os.tmpdir()].join(path.delimiter));
    expect(environment.PATH).toBe(os.tmpdir());
    const otherHome = path.join(os.tmpdir(), "dscode-other-home");
    vi.stubEnv("DSCODE_HOME", otherHome);
    expect(withPiManagedBinPath(environment).PATH).toBe([path.join(otherHome, "bin"), os.tmpdir()].join(path.delimiter));
  });

  it("uses host access without granting full tool permissions", async () => {
    vi.stubGlobal("DSCODE_STANDALONE", true);
    vi.stubEnv("DSCODE_SANDBOX", undefined);
    vi.stubEnv("DSCODE_PERMISSION", "auto");
    vi.resetModules();
    const { parseRuntimeArgs } = await import("../packages/core/src/runtime-options.ts");
    const { SessionAccessController } = await import("../packages/core/src/access.ts");
    expect(parseRuntimeArgs([]).options).toMatchObject({ sandbox: "danger-full-access", permission: "auto" });
    expect(new SessionAccessController("danger-full-access", true).effective("auto")).toEqual({
      sandbox: "danger-full-access", network: true,
    });
    expect(parseRuntimeArgs(["--sandbox", "read-only"]).options.sandbox).toBe("read-only");
    expect(new SessionAccessController("read-only", false).effective("auto").sandbox).toBe("read-only");
  });

  it("keeps the explicit Node sandbox selection", async () => {
    vi.stubGlobal("DSCODE_STANDALONE", false);
    vi.resetModules();
    const { SessionAccessController } = await import("../packages/core/src/access.ts");
    expect(new SessionAccessController("danger-full-access", true).effective("auto").sandbox).toBe("danger-full-access");
  });

  it("uses embedded version metadata", async () => {
    vi.stubGlobal("DSCODE_STANDALONE", true);
    vi.stubGlobal("DSCODE_BUILD_VERSION", "standalone-test-version");
    vi.resetModules();
    const { DSCODE_VERSION } = await import("../packages/core/src/version.ts");
    expect(DSCODE_VERSION).toBe("standalone-test-version");
  });

  it("forces file credentials even when a caller requests keyring", async () => {
    vi.stubGlobal("DSCODE_STANDALONE", true);
    vi.resetModules();
    const { createDSCodeCredentialStore, FileCredentialStore } = await import("../packages/core/src/credential-store.ts");
    const create = vi.fn(() => { throw new Error("Keyring must not be accessed"); });
    const store = await createDSCodeCredentialStore({ mode: "keyring", authPath: "/unused/auth.json", keyringFactory: { create } });
    expect(store).toBeInstanceOf(FileCredentialStore);
    expect(create).not.toHaveBeenCalled();
  });
});
