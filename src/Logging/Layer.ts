import { Effect, Layer, Logger, LogLevel } from "effect";

export const LoggingLive = Layer.mergeAll(
  Logger.minimumLogLevel(LogLevel.Info),
  // You can add more logger configuration here, like changing the format to JSON for production
);

/**
 * Utility to wrap an effect in a span and annotate all logs within it.
 */
export const withContext =
  (name: string, annotations: Record<string, string | number | boolean>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.annotateLogs(annotations),
      Effect.withSpan(name, { attributes: annotations }),
    );
