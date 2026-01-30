#!/usr/bin/env -S deno run --allow-all

import { $, DOCKER_CMD } from "./utils.ts";

const profiles = $.argv
  .map((prof) => `--profile ${prof}`)
  .join(" ");

await $.raw`${DOCKER_CMD} compose -f compose.yml ${profiles} down`.cwd(
  $.path(import.meta.resolve("../tools/")),
);
