import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { installDSCodeRuntimeBranding } from "../packages/core/src/runtime-branding.ts";

describe("DSCode runtime branding", () => {
  it("brands shutdown output and restores stdout when shutdown throws", async () => {
    const prototype = InteractiveMode.prototype as unknown as {
      shutdown(): Promise<void>;
    };
    const originalShutdown = prototype.shutdown;
    const failure = new Error("shutdown failed");
    const shutdown = vi.fn(async () => {
      process.stdout.write("\u001b[2mTo resume this session:\u001b[22m pi --session-dir '/home/test user/.dscode/sessions' --session session-id\n");
      process.stdout.write("other pi output\n");
      throw failure;
    });
    prototype.shutdown = shutdown;
    installDSCodeRuntimeBranding();
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      await expect(prototype.shutdown()).rejects.toBe(failure);
      expect(write).toHaveBeenCalledWith("\u001b[2mTo resume this session:\u001b[22m dscode --session-dir '/home/test user/.dscode/sessions' --session session-id\n");
      expect(write).toHaveBeenCalledWith("other pi output\n");
      expect(process.stdout.write).toBe(write);
    } finally {
      write.mockRestore();
      prototype.shutdown = originalShutdown;
    }
  });

  it("does not rewrite dynamic UI messages", () => {
    const prototype = InteractiveMode.prototype as unknown as {
      showStatus: unknown;
      showWarning: unknown;
      showError: unknown;
    };
    const originalMethods = {
      showStatus: prototype.showStatus,
      showWarning: prototype.showWarning,
      showError: prototype.showError,
    };

    installDSCodeRuntimeBranding();

    expect(prototype.showStatus).toBe(originalMethods.showStatus);
    expect(prototype.showWarning).toBe(originalMethods.showWarning);
    expect(prototype.showError).toBe(originalMethods.showError);
  });

  it("owns the terminal title", () => {
    installDSCodeRuntimeBranding();
    const setTitle = vi.fn();
    const runtime = {
      ui: { terminal: { setTitle } },
      sessionManager: {
        getCwd: () => "/work/my-project",
        getSessionName: () => "refactor",
      },
    };

    const updateTitle = (
      InteractiveMode.prototype as unknown as {
        updateTerminalTitle(this: typeof runtime): void;
      }
    ).updateTerminalTitle;
    updateTitle.call(runtime);

    expect(setTitle).toHaveBeenCalledWith("DSCode — refactor — my-project");
  });
});
