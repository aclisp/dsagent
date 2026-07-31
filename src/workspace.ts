import fs from "node:fs/promises";
import path from "node:path";

export class Workspace {
  readonly root: string;
  private realRoot?: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async initialize(): Promise<void> {
    const stat = await fs.stat(this.root);
    if (!stat.isDirectory()) {
      throw new Error(`Workspace is not a directory: ${this.root}`);
    }
    this.realRoot = await fs.realpath(this.root);
  }

  async resolve(userPath: string, allowMissing = false): Promise<string> {
    if (userPath.includes("\0")) {
      throw new Error("Path contains a null byte");
    }

    const candidate = path.resolve(this.root, userPath);
    this.assertLexicallyInside(candidate);

    if (!this.realRoot) {
      await this.initialize();
    }

    try {
      const real = await fs.realpath(candidate);
      this.assertReallyInside(real);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !allowMissing) {
        throw error;
      }
    }

    const existingParent = await this.findExistingParent(path.dirname(candidate));
    const realParent = await fs.realpath(existingParent);
    this.assertReallyInside(realParent);
    return candidate;
  }

  relative(absolutePath: string): string {
    return path.relative(this.root, absolutePath) || ".";
  }

  private assertLexicallyInside(candidate: string): void {
    const relative = path.relative(this.root, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Path escapes workspace: ${candidate}`);
    }
  }

  private assertReallyInside(candidate: string): void {
    const relative = path.relative(this.realRoot!, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Path resolves outside workspace: ${candidate}`);
    }
  }

  private async findExistingParent(start: string): Promise<string> {
    let current = start;
    while (true) {
      try {
        await fs.access(current);
        return current;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }

      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error(`No existing parent for path: ${start}`);
      }
      current = parent;
    }
  }
}

