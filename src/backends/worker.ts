import { getLogger, setupLoggers } from "../utils/log.ts";
import { processTask } from "./mirror.ts";
import { MirrorTask } from "./types.ts";
import { configInit } from "../config/mod.ts";
import { inWorker } from "../utils/mod.ts";
import { MirrorTaskMessage } from "./tasks.ts";
import { Bucket } from "../buckets/mod.ts";

if (inWorker()) {
  await configInit();
  setupLoggers();
}

function convertMessageToTask(
  msg: MessageEvent<MirrorTaskMessage>,
): MirrorTask {
  return {
    mainBucketConfig: Bucket.fromJSON(msg.data.mainBucketConfig),
    backupBucketConfig: Bucket.fromJSON(msg.data.backupBucketConfig),
    command: msg.data.command,
    originalRequest: msg.data.originalRequest,
    nonce: msg.data.nonce,
  };
}

self.onmessage = onMsg;
self.postMessage(`Worker started ${self.name}`);

async function onMsg(msg: MessageEvent<MirrorTaskMessage>) {
  const task = convertMessageToTask(msg);
  const logger = getLogger(import.meta);

  logger.info(
    `Processing task: ${task.command}`,
  );
  await processTask(task);
  self.postMessage("Task completed");
}
