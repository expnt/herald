#!/usr/bin/env -S deno run --allow-all

import { $ } from "./utils.ts";

await $`deno task dev`;
