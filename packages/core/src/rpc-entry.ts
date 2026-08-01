#!/usr/bin/env node

import process from "node:process";
import { runDSCodeProcess } from "./cli-runtime.js";

void runDSCodeProcess(process.argv.slice(2));
