import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("standalone distribution defaults", () => {
  it("uses host access without granting full tool permissions, including plan subagents", async () => {
    vi.stubGlobal("DSCODE_STANDALONE", true);
    vi.stubEnv("DSCODE_SANDBOX", undefined);
    vi.stubEnv("DSCODE_PERMISSION", "auto");
    vi.resetModules();
    const { parseRuntimeArgs } = await import("../packages/core/src/runtime-options.js");
    const { SessionAccessController } = await import("../packages/core/src/access.js");
    expect(parseRuntimeArgs([]).options).toMatchObject({ sandbox: "danger-full-access", permission: "auto" });
    expect(new SessionAccessController("danger-full-access", true).effective("plan")).toEqual({
      sandbox: "danger-full-access", network: true,
    });
    expect(parseRuntimeArgs(["--sandbox", "read-only"]).options.sandbox).toBe("read-only");
    expect(new SessionAccessController("workspace-write", false).effective("plan").sandbox).toBe("read-only");
  });

  it("keeps Node plan execution read-only even with a host base sandbox", async () => {
    vi.stubGlobal("DSCODE_STANDALONE", false);
    vi.resetModules();
    const { SessionAccessController } = await import("../packages/core/src/access.js");
    expect(new SessionAccessController("danger-full-access", true).effective("plan").sandbox).toBe("read-only");
  });

  it("uses embedded version metadata", async () => {
    vi.stubGlobal("DSCODE_STANDALONE", true);
    vi.stubGlobal("DSCODE_BUILD_VERSION", "standalone-test-version");
    vi.resetModules();
    const { DSCODE_VERSION } = await import("../packages/core/src/version.js");
    expect(DSCODE_VERSION).toBe("standalone-test-version");
  });

  it("forces file credentials even when a caller requests keyring", async () => {
    vi.stubGlobal("DSCODE_STANDALONE", true);
    vi.resetModules();
    const { createDSCodeCredentialStore, FileCredentialStore } = await import("../packages/core/src/credential-store.js");
    const create = vi.fn(() => { throw new Error("Keyring must not be accessed"); });
    const store = await createDSCodeCredentialStore({ mode: "keyring", authPath: "/unused/auth.json", keyringFactory: { create } });
    expect(store).toBeInstanceOf(FileCredentialStore);
    expect(create).not.toHaveBeenCalled();
  });
});
