import { Effect, Stream } from "effect";
import { Buffer } from "node-buffer";
import { createHash } from "node-crypto";
import { BadDigest, type InvalidRequest } from "./Backend.ts";
import type { ChecksumAlgorithm, ChecksumHeaders } from "./S3Schema.ts";

/**
 * CRC32 implementation for S3 (IEEE 802.3)
 */
const CRC32_TABLE = new Int32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC32_TABLE[i] = c;
}

function crc32(data: Uint8Array, previous = 0) {
  let crc = previous ^ -1;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ data[i]) & 0xFF];
  }
  return (crc ^ -1) >>> 0;
}

/**
 * CRC32C (Castagnoli)
 */
const CRC32C_TABLE = new Int32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0x82F63B78 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC32C_TABLE[i] = c;
}

function crc32c(data: Uint8Array, previous = 0) {
  let crc = previous ^ -1;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ CRC32C_TABLE[(crc ^ data[i]) & 0xFF];
  }
  return (crc ^ -1) >>> 0;
}

export class Checksum extends Effect.Service<Checksum>()("Checksum", {
  succeed: {
    calculate: (
      stream: Stream.Stream<Uint8Array, Error>,
      algorithm: ChecksumAlgorithm,
    ): Effect.Effect<string, Error> =>
      Effect.gen(function* () {
        const algo = algorithm.toUpperCase();
        let sha256: ReturnType<typeof createHash> | undefined;
        let sha1: ReturnType<typeof createHash> | undefined;
        let currentCRC32: number | undefined;
        let currentCRC32C: number | undefined;

        yield* Stream.runForEach(stream, (chunk) =>
          Effect.sync(() => {
            if (algo === "SHA256") {
              if (!sha256) sha256 = createHash("sha256");
              sha256.update(chunk);
            } else if (algo === "SHA1") {
              if (!sha1) sha1 = createHash("sha1");
              sha1.update(chunk);
            } else if (algo === "CRC32") {
              if (currentCRC32 === undefined) currentCRC32 = 0;
              currentCRC32 = crc32(chunk, currentCRC32);
            } else if (algo === "CRC32C") {
              if (currentCRC32C === undefined) currentCRC32C = 0;
              currentCRC32C = crc32c(chunk, currentCRC32C);
            }
          }));

        if (algo === "SHA256") {
          if (!sha256) sha256 = createHash("sha256");
          return sha256.digest("base64");
        }
        if (algo === "SHA1") {
          if (!sha1) sha1 = createHash("sha1");
          return sha1.digest("base64");
        }
        if (algo === "CRC32") {
          const buf = Buffer.alloc(4);
          buf.writeUInt32BE(currentCRC32 ?? 0, 0);
          return buf.toString("base64");
        }
        if (algo === "CRC32C") {
          const buf = Buffer.alloc(4);
          buf.writeUInt32BE(currentCRC32C ?? 0, 0);
          return buf.toString("base64");
        }
        return yield* Effect.fail(
          new Error(`Unsupported checksum algorithm: ${algorithm}`),
        );
      }),

    validate: (
      stream: Stream.Stream<Uint8Array, Error>,
      expected: ChecksumHeaders,
    ): Effect.Effect<
      Stream.Stream<Uint8Array, Error>,
      BadDigest | InvalidRequest
    > =>
      Effect.gen(function* () {
        const algo = expected.algorithm;
        if (!algo) return stream;
        yield* Effect.logDebug(`Validating checksum with algorithm: ${algo}`);

        const algoUpper = algo.toUpperCase();
        let expectedValue: string | undefined;
        switch (algoUpper) {
          case "SHA256":
            expectedValue = expected.sha256;
            break;
          case "SHA1":
            expectedValue = expected.sha1;
            break;
          case "CRC32":
            expectedValue = expected.crc32;
            break;
          case "CRC32C":
            expectedValue = expected.crc32c;
            break;
          case "CRC64NVME":
            expectedValue = expected.crc64nvme;
            break;
          default:
            yield* Effect.logDebug(
              `Unsupported checksum algorithm: ${algo}, returning original stream`,
            );
            return stream;
        }

        if (!expectedValue) {
          yield* Effect.logDebug(
            `Expected checksum value missing for algorithm ${algo}, returning original stream`,
          );
          return stream;
        }

        let sha256: ReturnType<typeof createHash> | undefined;
        let sha1: ReturnType<typeof createHash> | undefined;
        let currentCRC32: number | undefined;
        let currentCRC32C: number | undefined;

        return stream.pipe(
          Stream.tap((chunk) =>
            Effect.sync(() => {
              if (algoUpper === "SHA256") {
                if (!sha256) sha256 = createHash("sha256");
                sha256.update(chunk);
              } else if (algoUpper === "SHA1") {
                if (!sha1) sha1 = createHash("sha1");
                sha1.update(chunk);
              } else if (algoUpper === "CRC32") {
                if (currentCRC32 === undefined) currentCRC32 = 0;
                currentCRC32 = crc32(chunk, currentCRC32);
              } else if (algoUpper === "CRC32C") {
                if (currentCRC32C === undefined) currentCRC32C = 0;
                currentCRC32C = crc32c(chunk, currentCRC32C);
              }
            })
          ),
          Stream.onEnd(Effect.gen(function* () {
            let calculated = "";
            if (algoUpper === "SHA256") {
              if (!sha256) sha256 = createHash("sha256");
              calculated = sha256.digest("base64");
            } else if (algoUpper === "SHA1") {
              if (!sha1) sha1 = createHash("sha1");
              calculated = sha1.digest("base64");
            } else if (algoUpper === "CRC32") {
              const buf = Buffer.alloc(4);
              buf.writeUInt32BE(currentCRC32 ?? 0, 0);
              calculated = buf.toString("base64");
            } else if (algoUpper === "CRC32C") {
              const buf = Buffer.alloc(4);
              buf.writeUInt32BE(currentCRC32C ?? 0, 0);
              calculated = buf.toString("base64");
            }

            if (calculated && calculated !== expectedValue) {
              yield* Effect.fail(
                new BadDigest({
                  message:
                    `Checksum mismatch. Expected ${expectedValue}, calculated ${calculated}`,
                }),
              );
            }
          })),
        );
      }),
  },
}) {}
