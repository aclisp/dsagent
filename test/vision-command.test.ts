import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createVisionProcessEnvironment,
  DEFAULT_VISION_CLI_EXECUTABLE,
  parseTrustedVisionCommand,
} from "../packages/core/src/vision-command.js";

describe("trusted dscode-vision command", () => {
  it("resolves the fixed script from the repository or application root", () => {
    expect(DEFAULT_VISION_CLI_EXECUTABLE).toBe(path.join(process.cwd(), "dist/vision-cli.js"));
  });

  it("accepts only the narrow literal CLI grammar", () => {
    expect(
      parseTrustedVisionCommand(
        `dscode-vision --image 'screen shot.png' --prompt "read all text"`,
      ),
    ).toEqual({
      args: ["--image", "screen shot.png", "--prompt", "read all text"],
    });
    expect(parseTrustedVisionCommand("dscode-vision --image screen\\ shot.png")).toEqual({
      args: ["--image", "screen shot.png"],
    });
    expect(
      parseTrustedVisionCommand(
        `dscode-vision --image "screen.png" --prompt "treat $IMAGE as text"`,
      ),
    ).toEqual({
      args: ["--image", "screen.png", "--prompt", "treat $IMAGE as text"],
    });
  });

  it("rejects shell syntax, wrappers, malformed quoting, and unsupported arguments", () => {
    for (const command of [
      "dscode-vision --image screen.png && env",
      "dscode-vision --image screen.png | tee result.txt",
      "dscode-vision --image screen.png > result.txt",
      "OPENROUTER_API_KEY=x dscode-vision --image screen.png",
      "sudo dscode-vision --image screen.png",
      "env dscode-vision --image screen.png",
      "dscode-vision --image $IMAGE",
      "dscode-vision --image `find-image`",
      `dscode-vision --image screen.png --prompt "$(env)"`,
      `dscode-vision --image screen.png --prompt "\`env\`"`,
      "dscode-vision --image *.png",
      "dscode-vision --image 'unterminated",
      "dscode-vision --image screen.png\nenv",
      "dscode-vision --help",
      "dscode-vision --image screen.png --unknown value",
      "dscode-vision --prompt inspect",
      "dscode-vision screen.png",
    ]) {
      expect(parseTrustedVisionCommand(command), command).toBeUndefined();
    }
  });

  it("builds an allowlisted environment and injects current thinking", () => {
    expect(
      createVisionProcessEnvironment(
        {
          OPENROUTER_API_KEY: "openrouter-key",
          OPENAI_API_KEY: "other-key",
          DSCODE_VISION_MODEL: "vision-model",
          DSCODE_VISION_THINKING: "stale",
          DSCODE_HOME: "/tmp/dscode-home",
          HOME: "/tmp/home",
          PATH: "/usr/bin",
          LANG: "en_US.UTF-8",
          LC_ALL: "en_US.UTF-8",
          CUSTOM_SECRET: "secret",
          NODE_OPTIONS: "--require malicious.cjs",
        },
        "max",
      ),
    ).toEqual({
      OPENROUTER_API_KEY: "openrouter-key",
      DSCODE_VISION_MODEL: "vision-model",
      DSCODE_HOME: "/tmp/dscode-home",
      HOME: "/tmp/home",
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      DSCODE_VISION_THINKING: "max",
    });
  });
});
