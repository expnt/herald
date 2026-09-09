#!/usr/bin/env -S deno run --allow-all
/**
 * Run s3-tests directly against MinIO (bypassing Herald proxy)
 *
 * This script runs the Ceph S3 compatibility test suite (s3-tests) directly
 * against a local MinIO instance. It handles:
 *  - Configuring s3-tests to point directly to MinIO
 *  - Running pytest with real-time output streaming
 *  - Parsing JUnit XML for a final summary
 *
 * Usage:
 *   ./x/s3-tests-direct.ts [pytest-args] [--no-abort]
 *
 * Environment Variables:
 *   S3TEST_TAGS: Custom pytest marks (default: not buckets and ...)
 *   S3TEST_PYTEST_ARGS: Additional pytest arguments
 *   S3TEST_NO_ABORT: Set to "true" to disable abort-on-error
 *   MINIO_ENDPOINT: MinIO endpoint (default: http://localhost:9100)
 *   MINIO_ACCESS_KEY: MinIO access key (default: minioadmin)
 *   MINIO_SECRET_KEY: MinIO secret key (default: minioadmin)
 */

import { Effect } from "effect";
import * as path from "@std/path";
import { $ } from "@david/dax";
import * as colors from "@std/fmt/colors";

const DEFAULT_TAGS =
  "not appendobject and not bucket_policy and not copy and not cors and not encryption and not fails_strict_rfc2616 and not iam_tenant and not iam_user and not iam_account and not lifecycle and not object_lock and not policy and not policy_status and not s3select and not s3website and not sse_s3 and not tagging and not test_of_sts and not user_policy and not versioning and not webidentity_test";

const program = Effect.gen(function* () {
  const __dirname = path.dirname(path.fromFileUrl(import.meta.url));
  const s3TestsDir = path.resolve(__dirname, "../s3-tests");

  // Parse arguments
  const rawArgs = [...Deno.args];
  const noAbort = rawArgs.includes("--no-abort") ||
    Deno.env.get("S3TEST_NO_ABORT") === "true";

  const pytestArgsFromCli = rawArgs.filter((arg) => arg !== "--no-abort");

  // MinIO configuration
  const minioEndpoint = Deno.env.get("MINIO_ENDPOINT") ||
    "http://localhost:9100";
  const minioAccessKey = Deno.env.get("MINIO_ACCESS_KEY") || "minioadmin";
  const minioSecretKey = Deno.env.get("MINIO_SECRET_KEY") || "minioadmin";

  // Parse endpoint to get host and port
  const endpointUrl = new URL(minioEndpoint);
  const host = endpointUrl.hostname;
  const port = endpointUrl.port ||
    (endpointUrl.protocol === "https:" ? "443" : "80");
  const isSecure = endpointUrl.protocol === "https:";

  return yield* (Effect.gen(function* () {
    console.log(
      `Running s3-tests directly against MinIO at ${
        colors.cyan(minioEndpoint)
      }`,
    );

    const confContent = `[DEFAULT]
host = ${host}
port = ${port}
is_secure = ${isSecure ? "yes" : "no"}

[fixtures]
bucket prefix = minio-direct-{random}-

[s3 main]
user_id = main
display_name = main
email = main@example.com
access_key = ${minioAccessKey}
secret_key = ${minioSecretKey}

[s3 alt]
user_id = alt
display_name = alt
email = alt@example.com
access_key = ${minioAccessKey}
secret_key = ${minioSecretKey}

[s3 tenant]
user_id = tenant
display_name = tenant
email = tenant@example.com
access_key = ${minioAccessKey}
secret_key = ${minioSecretKey}
tenant = testx

[iam]
email = iam@example.com
user_id = iam
access_key = ${minioAccessKey}
secret_key = ${minioSecretKey}
display_name = iam

[iam root]
access_key = ${minioAccessKey}
secret_key = ${minioSecretKey}
user_id = iam_root
email = iam_root@example.com

[iam alt root]
access_key = ${minioAccessKey}
secret_key = ${minioSecretKey}
user_id = iam_alt_root
email = iam_alt_root@example.com
`;

    const confPath = yield* Effect.promise(() =>
      Deno.makeTempFile({ suffix: ".conf" })
    );
    yield* Effect.promise(() => Deno.writeTextFile(confPath, confContent));

    const logPath = path.join(s3TestsDir, "s3-tests-direct.log");

    console.log(`s3-tests directory: ${colors.gray(s3TestsDir)}`);
    console.log(`Log file: ${colors.gray(logPath)}`);

    // Register finalizer to clean up conf file
    yield* Effect.addFinalizer(() =>
      Effect.tryPromise({
        try: () =>
          Deno.remove(confPath).catch((e) => {
            console.error(`Failed to remove conf file ${confPath}: ${e}`);
          }),
        catch: (e) => new Error(`Effect.tryPromise failed: ${e}`),
      }).pipe(Effect.orDie)
    );

    // Ensure we have a virtual environment
    const venvPath = path.join(s3TestsDir, ".venv");
    const venvExists = yield* Effect.tryPromise(() =>
      Deno.stat(venvPath).then(() => true).catch(() => false)
    );

    if (!venvExists) {
      console.log(colors.yellow("Creating Python virtual environment..."));
      yield* Effect.tryPromise(() => $`uv venv --python 3.11`.cwd(s3TestsDir));
    }

    // Ensure dependencies are installed
    const pytestCheck = yield* Effect.tryPromise({
      try: async () => {
        const proc = $`uv run pytest --version`.cwd(s3TestsDir).noThrow();
        return await proc;
      },
      catch: () => new Error("Check failed"),
    });

    if (pytestCheck.code !== 0) {
      console.log(colors.yellow("Installing s3-tests dependencies..."));
      yield* Effect.tryPromise({
        try: async () => {
          await $`uv pip install -r requirements.txt`.cwd(s3TestsDir);
          await $`uv pip install -e .`.cwd(s3TestsDir);
        },
        catch: (e) => new Error(`Failed to install dependencies: ${e}`),
      });
    }

    const tags = Deno.env.get("S3TEST_TAGS") ?? DEFAULT_TAGS;
    const pytestArgsEnv = Deno.env.get("S3TEST_PYTEST_ARGS") ?? "";
    const pytestArgsFromEnv = pytestArgsEnv ? pytestArgsEnv.split(/\s+/) : [];
    const pytestArgs = [...pytestArgsFromEnv, ...pytestArgsFromCli];

    console.log(`Running s3-tests against MinIO...`);
    if (tags) console.log(`${colors.gray("Tags:")} ${tags}`);
    if (pytestArgs.length > 0) {
      console.log(
        `${colors.gray("Additional pytest args:")} ${pytestArgs.join(" ")}`,
      );
    }
    if (noAbort) {
      console.log(colors.yellow("Abort on ERROR disabled (--no-abort)"));
    }

    // Build command arguments
    const cmdArgs = [
      "-v",
      "--tb=short",
    ];

    const junitXmlName = "junit.xml";
    const junitXmlPath = path.join(s3TestsDir, junitXmlName);
    cmdArgs.push(`--junit-xml=${junitXmlName}`);

    if (tags) {
      cmdArgs.push("-m", tags);
    }

    cmdArgs.push(...pytestArgs);

    const logFile = yield* Effect.tryPromise(() =>
      Deno.open(logPath, {
        write: true,
        create: true,
        truncate: true,
      })
    );

    console.log(`Command: uv run pytest ${cmdArgs.join(" ")}`);
    const child = $`uv run pytest ${cmdArgs}`
      .cwd(s3TestsDir)
      .env({
        S3TEST_CONF: confPath,
        PYTHONUNBUFFERED: "1",
        // See x/s3-tests.ts: the teardown's IAM ListRoles 500 + boto3 retry
        // backoff dominates runtime; one attempt keeps failures fast.
        AWS_MAX_ATTEMPTS: "1",
      })
      .stdout("piped")
      .stderr("piped")
      .spawn();

    const sigintHandler = () => {
      console.log(colors.yellow("\nReceived SIGINT, shutting down..."));
      child.kill("SIGTERM");
    };
    Deno.addSignalListener("SIGINT", sigintHandler);

    const result = yield* Effect.tryPromise({
      try: async () => {
        let failedCount = 0;
        let errorCount = 0;
        let skippedCount = 0;
        let lastResultTime = Date.now();
        const seenTests = new Set<string>();
        const failedTests = new Set<string>();
        const errorTests = new Set<string>();
        let currentTestName = "";

        let shouldAbort = false;
        let abortReason = "";

        const processLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;

          // Capture test result lines like:
          // s3tests/functional/test_s3.py::test_bucket_list_empty PASSED [ 0%]
          const resultMatch = trimmed.match(
            /^([^\s]+::[^\s]+)\s+(PASSED|FAILED|ERROR|SKIPPED)/,
          );
          if (resultMatch) {
            const testName = resultMatch[1];
            const status = resultMatch[2];
            const now = Date.now();
            const duration = ((now - lastResultTime) / 1000).toFixed(2);
            lastResultTime = now;
            currentTestName = testName;

            if (status === "PASSED") {
              console.log(
                `${colors.green("✓")} ${testName} ${
                  colors.gray(`(${duration}s)`)
                }`,
              );
            } else if (status === "FAILED") {
              if (!seenTests.has(testName)) {
                failedCount++;
                seenTests.add(testName);
                failedTests.add(testName);
              }
              console.error(
                `${colors.red("✗")} ${testName} ${
                  colors.gray(`(${duration}s)`)
                }`,
              );
            } else if (status === "ERROR") {
              if (!seenTests.has(testName)) {
                errorCount++;
                seenTests.add(testName);
                errorTests.add(testName);
              }
              console.error(
                `${colors.red("✗ ERROR:")} ${testName} ${
                  colors.gray(`(${duration}s)`)
                }`,
              );
              if (!noAbort) {
                shouldAbort = true;
                abortReason = `ERROR in ${testName}`;
                child.kill("SIGTERM");
              }
            } else if (status === "SKIPPED") {
              skippedCount++;
              console.log(
                `${colors.yellow("-")} ${testName} ${
                  colors.gray(`(${duration}s)`)
                }`,
              );
            }
            return;
          }

          // Also check for ERROR in non-verbose format
          const errorMatch = trimmed.match(/^ERROR\s+([^\s]+::[^\s]+)/);
          if (errorMatch) {
            const testName = errorMatch[1];
            const now = Date.now();
            const duration = ((now - lastResultTime) / 1000).toFixed(2);
            lastResultTime = now;
            currentTestName = testName;

            if (!seenTests.has(testName)) {
              errorCount++;
              seenTests.add(testName);
              errorTests.add(testName);
            }
            console.error(
              `${colors.red("✗ ERROR:")} ${testName} ${
                colors.gray(`(${duration}s)`)
              }`,
            );

            if (!noAbort) {
              shouldAbort = true;
              abortReason = `ERROR in ${testName}`;
              child.kill("SIGTERM");
            }
            return;
          }

          // Echo important lines (failures, tracebacks, summaries)
          if (
            trimmed.includes("FAILURES") ||
            trimmed.includes("ERRORS") ||
            trimmed.includes("short test summary") ||
            trimmed.startsWith("E   ") || // Traceback lines in short format
            trimmed.startsWith(">   ") ||
            trimmed.match(/^=+\s*(passed|failed|error)/i)
          ) {
            const prefix = currentTestName
              ? colors.gray(`[${currentTestName}] `)
              : "";
            console.log(`${prefix}${trimmed}`);
          }
        };

        const decoder = new TextDecoder();

        async function streamToLogAndConsole(
          stream: ReadableStream<Uint8Array>,
        ) {
          const reader = stream.getReader();
          let buffer = "";
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              try {
                await logFile.write(value);
              } catch (e) {
                console.error(`Failed to write to log file: ${e}`);
              }
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";
              for (const line of lines) {
                processLine(line);
              }
            }
          } catch (e) {
            if (!(e instanceof Deno.errors.Interrupted)) {
              console.error(`Stream error: ${e}`);
            }
          } finally {
            if (buffer) {
              processLine(buffer);
            }
            reader.releaseLock();
          }
        }

        const [procResult] = await Promise.allSettled([
          child,
          streamToLogAndConsole(child.stdout()),
          streamToLogAndConsole(child.stderr()),
        ]);

        Deno.removeSignalListener("SIGINT", sigintHandler);

        const exitCode = procResult.status === "fulfilled"
          ? procResult.value.code
          : 1;

        // Attempt to parse JUnit XML if it exists and is valid
        let junitData: {
          tests: number;
          failures: number;
          errors: number;
          skipped: number;
          time?: number;
          failedNames: string[];
          errorNames: string[];
        } | null = null;

        try {
          const junitXml = await Deno.readTextFile(junitXmlPath);
          const getAttr = (name: string) => {
            const match = junitXml.match(new RegExp(`${name}="([\\d.]+)"`));
            return match ? parseFloat(match[1]) : 0;
          };

          const failedNames: string[] = [];
          const errorNames: string[] = [];

          const testcaseMatches = junitXml.matchAll(
            /<testcase classname="([^"]+)" name="([^"]+)"[^>]*>([\s\S]*?)<\/testcase>/g,
          );
          for (const match of testcaseMatches) {
            const fullName = `${match[1]}::${match[2]}`;
            const content = match[3];
            if (content.includes("<failure")) failedNames.push(fullName);
            if (content.includes("<error")) errorNames.push(fullName);
          }

          junitData = {
            tests: Math.floor(getAttr("tests")),
            failures: Math.floor(getAttr("failures")),
            errors: Math.floor(getAttr("errors")),
            skipped: Math.floor(getAttr("skipped")),
            time: getAttr("time"),
            failedNames,
            errorNames,
          };
        } catch (e) {
          console.error(`Failed to parse JUnit XML: ${e}`);
        }

        // Use streaming counts if JUnit failed or reported 0
        const finalCounts = (junitData && junitData.tests > 0) ? junitData : {
          tests: seenTests.size,
          failures: failedCount,
          errors: errorCount,
          skipped: skippedCount,
          time: undefined,
          failedNames: Array.from(failedTests),
          errorNames: Array.from(errorTests),
        };

        return {
          code: exitCode,
          counts: finalCounts,
          shouldAbort,
          abortReason,
        };
      },
      catch: (e) => new Error(`Failed to run pytest: ${e}`),
    });

    const { tests, failures, errors, skipped, time, failedNames, errorNames } =
      result.counts;
    const passed = tests - failures - errors - skipped;

    console.log();
    const durationStr = time ? ` ${colors.cyan(`${time.toFixed(2)}s`)}` : "";
    console.log(
      `${colors.bold(tests.toString())} tests completed in${durationStr}:`,
    );
    console.log(
      `  ${colors.green("successes")}: ${
        colors.bold(passed.toString())
      }/${tests}`,
    );
    console.log(
      `  ${colors.red("failures")}:  ${
        colors.bold(failures.toString())
      }/${tests}`,
    );
    if (errors > 0) {
      console.log(
        `  ${colors.red("errors")}:    ${
          colors.bold(errors.toString())
        }/${tests}`,
      );
    }
    if (skipped > 0) {
      console.log(
        `  ${colors.gray("skipped")}:   ${
          colors.bold(skipped.toString())
        }/${tests}`,
      );
    }

    if (failedNames.length > 0) {
      console.log(colors.red("\nFailures:"));
      for (const name of failedNames) {
        console.log(`  ${colors.red("-")} ${name}`);
      }
    }

    if (errorNames.length > 0) {
      console.log(colors.red("\nErrors:"));
      for (const name of errorNames) {
        console.log(`  ${colors.red("-")} ${name}`);
      }
    }

    if (errors > 0 || (result.shouldAbort && result.abortReason)) {
      if (result.shouldAbort) {
        yield* Effect.fail(
          new Error(
            `Aborted due to ERROR: ${result.abortReason || "Test Error"}`,
          ),
        );
      } else {
        yield* Effect.fail(new Error(`s3-tests finished with errors.`));
      }
    }

    if (failures > 0 || result.code !== 0) {
      yield* Effect.fail(
        new Error(`s3-tests finished with failures (code ${result.code}).`),
      );
    }

    console.log(colors.green(`\n✓ s3-tests completed successfully.`));
  }));
});

if (import.meta.main) {
  // Add a global unhandled rejection handler to catch stray promises
  globalThis.addEventListener("unhandledrejection", (e) => {
    // Suppress Interrupted errors - these happen when requests/streams are aborted
    if (e.reason instanceof Deno.errors.Interrupted) {
      e.preventDefault();
      return;
    }
    console.error(colors.red(`Unhandled rejection: ${e.reason}`));
  });

  Effect.runPromiseExit(program.pipe(Effect.scoped)).then((exitCode) => {
    if (exitCode._tag === "Failure") {
      console.error(
        colors.red(`Fatal error: ${JSON.stringify(exitCode.cause, null, 2)}`),
      );
      Deno.exit(1);
    }
  }).catch((e) => {
    console.error(colors.red(`Unhandled error: ${e}`));
    Deno.exit(1);
  });
}
