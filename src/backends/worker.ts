import { getLogger, setupLoggers } from "../utils/log.ts";
import { processTask } from "./mirror.ts";
import { MirrorTask } from "./types.ts";
import { configInit } from "../config/mod.ts";
import { inWorker } from "../utils/mod.ts";

if (inWorker()) {
  await configInit();
  setupLoggers();
}

self.onmessage = onMsg;
self.postMessage(`Worker started ${self.name}`);

async function onMsg(msg: MessageEvent<MirrorTask>) {
  const task = msg.data;
  const logger = getLogger(import.meta);

  logger.info(
    `Processing task: ${task.command}`,
  );
  await processTask(task);
  self.postMessage("Task completed");
}
