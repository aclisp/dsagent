import type { ChildProcess } from "node:child_process";

export function ptyInvocation(command: string, args: string[], probe?: boolean): { command: string; args: string[] };
export function terminatePty(child: ChildProcess): void;
export function isolatedRuntimeEnvironment(home: string, temporary: string, restrictPath?: boolean): NodeJS.ProcessEnv;
