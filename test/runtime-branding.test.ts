import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import {
  installDSCodeRuntimeBranding,
  sanitizeDSCodeRuntimeText,
} from "../packages/core/src/runtime-branding.js";

describe("DSCode runtime branding", () => {
  it("removes implementation branding from user-facing messages", () => {
    expect(
      sanitizeDSCodeRuntimeText(
        "Project .pi resources are ignored. Restart pi. π - workspace",
      ),
    ).toBe("Project .dscode resources are ignored. Restart DSCode. DSCode - workspace");
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
