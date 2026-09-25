import { makeDangerousMatch, type DangerousMatch } from "./match.js";
import { parseOptions } from "./options.js";

export function dangerousGitMatch(args: string[], elevated: boolean): DangerousMatch | undefined {
  let index = 0;
  while (args[index]?.startsWith("-")) {
    const option = args[index++]!;
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(option)) index++;
    else if (!/^(?:-[Cc].+|--(?:git-dir|work-tree|namespace|config-env)=.+)$/.test(option) &&
      !["--no-pager", "--paginate", "--no-optional-locks", "--bare"].includes(option)) return;
  }
  const subcommand = args[index++];
  const rest = args.slice(index);
  if (rest.length === 1 && ["-h", "--help"].includes(rest[0]!)) return;
  const separator = rest.indexOf("--");
  const options = separator < 0 ? rest : rest.slice(0, separator);
  const has = (flag: string) => options.includes(flag);
  const short = (flag: string) => options.some((arg) => /^-[^-]/.test(arg) && arg.slice(1).includes(flag));
  switch (subcommand) {
    case "worktree": {
      if (rest[0] !== "remove") break;
      const removal = parseOptions(rest.slice(1), {
        flags: ["-f", "--force", "-h", "--help"],
        aliases: { "-f": "--force", "-h": "--help" },
      });
      if (removal?.flags.has("--force") && !removal.flags.has("--help")) {
        return makeDangerousMatch("git worktree remove --force can delete uncommitted files", "Force-remove a Git worktree and its local files", elevated);
      }
      break;
    }
    case "rm":
      if ((has("--force") || short("f")) && !has("--cached") && !has("--dry-run") && !short("n")) {
        return makeDangerousMatch("git rm --force can discard working tree changes", "Force-remove tracked files; local changes may be lost", elevated);
      }
      break;
    case "switch":
      if (has("--discard-changes") || has("--force") || short("f")) {
        return makeDangerousMatch("git switch discards working tree changes", "Switch branches and discard working tree changes", elevated);
      }
      break;
    case "stash":
      if (rest.length === 2 && ["-h", "--help"].includes(rest[1]!)) break;
      if (rest[0] === "clear") {
        return makeDangerousMatch("git stash clear deletes all saved stashes", "Delete all saved Git stashes", elevated);
      }
      if (rest[0] === "drop") {
        return makeDangerousMatch("git stash drop deletes a saved stash", "Delete a saved Git stash", elevated);
      }
      break;
    case "clean":
      if (!has("--dry-run") && !short("n")) {
        return makeDangerousMatch("git clean removes untracked files", "Delete untracked files from the repository", elevated);
      }
      break;
    case "reset":
      if (has("--hard")) {
        return makeDangerousMatch("git reset --hard discards working tree changes", "Reset the index and working tree, discarding changes", elevated);
      }
      break;
    case "restore":
      if ((!has("--staged") && !short("S")) || has("--worktree") || short("W")) {
        return makeDangerousMatch("git restore overwrites working tree files", "Restore files and overwrite working tree changes", elevated);
      }
      break;
    case "checkout":
      if ((separator >= 0 && separator < rest.length - 1) || has(".") || has("--force") || short("f")) {
        return makeDangerousMatch("git checkout can discard working tree changes", "Discard working tree changes with checkout", elevated);
      }
      break;
    case "branch":
      if (short("D") || ((has("--delete") || short("d")) && (has("--force") || short("f")))) {
        return makeDangerousMatch("git branch force-deletes a branch", "Force-delete a Git branch", elevated);
      }
      break;
  }
}
