#!/usr/bin/env node

import process from "node:process";
import { runVisionCliProcess } from "../packages/core/dist/vision-cli.js";

void runVisionCliProcess(process.argv.slice(2));
