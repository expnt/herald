#!/usr/bin/env -S deno run --allow-all

import { $, DOCKER_CMD } from "./utils.ts";

await $.raw`${DOCKER_CMD} compose down`.cwd($.relativeDir("../tools/"));

