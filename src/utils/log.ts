import { LevelName, Logger } from "std/log";
import { basename, dirname, extname } from "std/path/";
import * as log from "std/log";
import { envVarsConfig } from "../config/mod.ts";
import { magenta } from "std/fmt/colors";
import * as Sentry from "sentry";

const loggers = new Map<string, Logger>();

const consoleHandler = new log.ConsoleHandler("NOTSET", {
  formatter: (logRecord) => {
    const { datetime, levelName, msg, loggerName, args } = logRecord;

    const formattedDate = datetime
      ? datetime.toISOString().replace("T", " ").split(".")[0]
      : new Date().toISOString().replace("T", " ").split(".")[0];
    let finalMessasge =
      `${formattedDate} ${levelName} [${loggerName}] -- ${msg} ${
        args.length ? ` ${Deno.inspect(args)}` : ""
      }`;
    if (logRecord.level === log.LogLevels.DEBUG) {
      finalMessasge = magenta(finalMessasge);
    }
    return finalMessasge;
  },
});

export function setupLoggers(name: ImportMeta | string | null = null) {
  if (name && typeof name === "object") {
    const bname = basename(name.url);
    const dname = basename(dirname(name.url));
    name = `${dname}/${bname.replace(extname(bname), "")}`;
  }

  const defaultLogger = new log.Logger(name ?? "default", "INFO", {
    handlers: [consoleHandler],
  });
  loggers.set("", defaultLogger);
}

export function getLogLevel(): LevelName {
  if (envVarsConfig) {
    return envVarsConfig.log_level ?? "NOTSET";
  }

  return "NOTSET";
}

/**
 * Retrieves a logger instance based on the provided name and level.
 * If the name is an object, it extracts the base name and directory name from the URL and constructs a new name.
 * If a logger instance with the same name does not exist, it creates a new logger with the specified name and level,
 * and adds a console handler to it.
 * If the name is not provided, it retrieves the default logger instance.
 *
 * @param name - The name of the logger or an object containing the URL.
 * @param levelName - The level name for the logger (default: "NOTSET").
 * @returns The logger instance.
 */
export function getLogger(
  name: ImportMeta | string | null = null,
  levelName: LevelName = getLogLevel(),
): Logger {
  if (name && typeof name === "object") {
    const bname = basename(name.url);
    const dname = basename(dirname(name.url));
    name = `${dname}/${bname.replace(extname(bname), "")}`;

    let logger = loggers.get(name);
    if (!logger) {
      logger = new Logger(name, levelName, {
        handlers: [consoleHandler],
      });
      loggers.set(name, logger);
    }
    return logger;
  }

  const logger = log.getLogger(name ?? undefined);
  return logger;
}

export function reportToSentry(error: string | Error) {
  if (typeof error === "string") {
    Sentry.captureException(new Error(error));
  } else {
    Sentry.captureException(error);
  }
}

export { Logger };
