import { Hono } from "@hono/hono";

import { configInit, envVarsConfig, globalConfig } from "./config/mod.ts";
import { getLogger, reportToSentry, setupLoggers } from "./utils/log.ts";
import { resolveHandler } from "./backends/mod.ts";
import { HTTPException } from "./types/http-exception.ts";
import * as Sentry from "sentry";
import { authenicateRequestAndReturnPodServiceAccount } from "./auth/mod.ts";
// import { taskHandler } from "./backends/tasks.ts";

// setup
await configInit();
await setupLoggers();

// Sentry setup
Sentry.init({
  dsn: envVarsConfig.sentry_dsn,
  release: envVarsConfig.version,
  environment: envVarsConfig.env === "DEV" ? "development" : "production",
  sampleRate: envVarsConfig.sentry_sample_rate,
  tracesSampleRate: envVarsConfig.sentry_traces_sample_rate,
  // integrations: [
  //   new Sentry.Integrations.Context({
  //     app: true,
  //     os: true,
  //     device: true,
  //     culture: true,
  //   }),
  // ],
  debug: true,
});
self.addEventListener("error", (event: ErrorEvent) => {
  Sentry.captureException(event.error);
});

self.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
  Sentry.captureException(event.reason);
});

const app = new Hono();
const logger = getLogger(import.meta);

app.all("/*", async (c) => {
  const path = c.req.path;
  let logMsg = `Receieved request on ${c.req.url}`;
  logger.debug(logMsg);

  if (path === "/health-check") {
    // TODO: thorough health check,
    const healthStatus = "Ok";
    logMsg = `Health Check Complete: ${healthStatus}`;

    logger.info(logMsg);
    return c.text(healthStatus, 200);
  }

  if (path === "/") {
    return c.text("Proxy is running...", 200);
  }

  const token = c.req.header("Authorization");
  if (!token) {
    const errMessage = "No token provided";
    throw new HTTPException(401, {
      message: errMessage,
    });
  }
  const serviceAccountName = await authenicateRequestAndReturnPodServiceAccount(
    token,
  );

  const response = await resolveHandler(c, serviceAccountName);
  return response;
});

app.notFound((c) => {
  const errMessage = `Resource not found: ${c.req.url}`;
  logger.warn(errMessage);
  reportToSentry(errMessage);
  return c.text("Not Found", 404);
});

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    // Get the custom response
    const errResponse = err.getResponse();

    return errResponse;
  }

  const errMessage = "Something wrong happened in the proxy.";
  logger.error(errMessage);
  reportToSentry(errMessage);
  return c.text(errMessage);
});

// taskHandler();

Deno.serve({ port: globalConfig.port }, app.fetch);

export default app;
