import { z } from "zod";

export const transportSchema = z.enum(["responses", "chat"]);
export type ModelTransport = z.infer<typeof transportSchema>;
export const permissionSchema = z.enum(["ask", "auto", "full"]);
export type PermissionMode = z.infer<typeof permissionSchema>;
