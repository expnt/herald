import {
  initializeTaskHandler,
  refreshWorkersContext,
} from "../backends/tasks.ts";
import { HeraldContext } from "../types/mod.ts";
import { getLogger } from "../utils/log.ts";

const logger = getLogger(import.meta);
export async function registerWorkers(ctx: HeraldContext) {
  logger.info("Registering Workers...");

  // Mirror task handler workers
  logger.info("Registering Worker: Task Handler");
  await initializeTaskHandler(ctx);

  // update the workers context every 5 minutes
  setInterval(() => {
    logger.info("Refreshing workers context");
    refreshWorkersContext(ctx);
  }, 5 * 60 * 1000); // 5 minutes in milliseconds

  logger.info("Workers: Task Handler Workers Registered");
}
