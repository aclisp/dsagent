---
name: dscode-vision
description: Analyze user-provided screenshots, photos, scans, charts, diagrams, and other image files with the installed `dscode-vision` CLI, then use the observations to answer the user's actual question. Use whenever a task requires understanding visual content or extracting text from an uploaded attachment or an explicitly identified workspace image.
---

# DSCode Vision

Use `dscode-vision` through `exec_command` to inspect one image at a time.

1. Use only an image path supplied by the user through an attachment or explicitly identified in
   the workspace. Do not choose an unrelated image or guess its contents from the filename.
2. Pass the user's actual question as `--prompt`. Ask for the specific visual details or text needed
   to answer it instead of requesting a generic description.
3. Keep the trusted command in this exact form, quoting both values:

```bash
dscode-vision --image "uploads/screenshot.png" --prompt "Explain this error and extract the key message"
```

Do not wrap the command with `env`, `sudo`, or another executable, and do not add pipes,
redirections, command substitution, or command chaining.

The command already runs from the workspace. If the image is in a subdirectory, put that directory
in the `--image` value instead of changing directories first:

```bash
dscode-vision --image "/workspace/canvas-transient-route/transient-route.png" --prompt "Analyze this image"
```

Never use `cd ... && dscode-vision ...`.

For multiple images, run one command per image and then compare or summarize the observations.
Treat stdout as supporting visual observations: integrate it into a natural answer instead of
mechanically forwarding it to the user.

If the CLI fails, clearly say that the image could not be read and briefly report the useful error
reason. Do not infer image content from the path or filename. Do not inspect, print, or discuss API
keys, and do not call the regular `dscode` command to bypass the dedicated vision CLI.
