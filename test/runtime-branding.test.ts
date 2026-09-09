import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { installDSCodeRuntimeBranding } from "../packages/core/src/runtime-branding.js";

describe("DSCode runtime branding", () => {
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
