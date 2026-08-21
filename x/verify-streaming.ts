import { Effect, Stream } from "effect";
import { Checksum } from "../src/Services/Checksum.ts";

/**
 * This script verifies that our Stream-based validation and processing
 * does not buffer the entire content in memory.
 */

const ONE_GB = 1024 * 1024 * 1024;
const CHUNK_SIZE = 1024 * 1024; // 1MB chunks

const formatMemory = (bytes: number) =>
  `${(bytes / 1024 / 1024).toFixed(2)} MB`;

const run = Effect.gen(function* () {
  const checksum = yield* Checksum;

  console.log("Starting memory:", formatMemory(Deno.memoryUsage().heapUsed));

  // Create a 1GB stream of dummy data using a generator to avoid pre-allocating memory
  const dummyChunk = new Uint8Array(CHUNK_SIZE).fill(0);

  function* generateChunks() {
    for (let i = 0; i < ONE_GB / CHUNK_SIZE; i++) {
      yield dummyChunk;
    }
  }

  let totalProcessed = 0;
  const massiveStream = Stream.fromIterable(generateChunks()).pipe(
    Stream.tap(() =>
      Effect.sync(() => {
        totalProcessed += CHUNK_SIZE;
        if (totalProcessed % (100 * 1024 * 1024) === 0) {
          console.log(
            `Processed ${totalProcessed / 1024 / 1024} MB... Current Heap: ${
              formatMemory(Deno.memoryUsage().heapUsed)
            }`,
          );
        }
      })
    ),
  );

  console.log("Validating stream (simulating Swift backend putObject)...");

  const validatedStreamResult = yield* checksum.validate(massiveStream, {
    algorithm: "SHA256",
    sha256: "not-real-but-onEnd-will-catch-it-at-the-very-end",
  });

  console.log("Stream validation pipeline initialized.");

  // Consume the stream
  try {
    yield* Stream.runDrain(validatedStreamResult);
  } catch (e) {
    if (String(e).includes("Checksum mismatch")) {
      console.log(
        "Successfully reached end of stream with expected checksum mismatch.",
      );
    } else {
      console.error("Unexpected error during stream consumption:", e);
    }
  }

  console.log("Final memory:", formatMemory(Deno.memoryUsage().heapUsed));
  console.log("Total processed:", totalProcessed / 1024 / 1024, "MB");
});

Effect.runPromise(
  run.pipe(Effect.provide(Checksum.Default)),
).catch((err) => {
  console.error("Top level error:", err);
});
