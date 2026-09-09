#!/usr/bin/env -S deno run --allow-all
/**
 * Herald S3 Compatibility Test Runner
 *
 * This script runs the Ceph S3 compatibility test suite (s3-tests) against
 * a local Herald proxy instance. It handles:
 *  - Starting the Herald proxy with a specified backend (rustfs or swift)
 *  - Configuring s3-tests to point to the proxy
 *  - Running pytest with real-time output streaming
 *  - Parsing JUnit XML for a final summary
 *  - Pass-list regression gate: s3-tests doesn't fully pass against Herald, so
 *    CI fails only if a checked-in known-passing test (x/s3-tests-pass-{backend}.txt)
 *    regresses. Newly-passing tests are reported; fold them in with --update-pass-list.
 *
 * Usage:
 *   ./x/s3-tests.ts [pytest-args] [--backend <rustfs|swift>] [--no-abort] [--update-pass-list]
 *
 * Environment Variables:
 *   S3TEST_TAGS: Custom pytest marks (default: not buckets and ...)
 *   S3TEST_PYTEST_ARGS: Additional pytest arguments
 *   S3TEST_NO_ABORT: Set to "true" to disable abort-on-error
 *   HERALD_LOG_LEVEL: Set to "DEBUG" for verbose proxy logging
 *
 * Files:
 *   s3-tests/s3tests.conf: Generated s3-tests configuration
 *   s3-tests/herald-proxy.log: Herald proxy logs (rustfs backend)
 *   s3-tests/herald-proxy-swift.log: Herald proxy logs (swift backend)
 *   s3-tests/s3-tests.log: Full pytest output
 */

import {
  Cause,
  Config,
  Effect,
  Exit,
  Layer,
  Logger,
  LogLevel,
  Option,
} from "effect";
import * as path from "@std/path";
import { $ } from "@david/dax";
import * as colors from "@std/fmt/colors";
import { makeTestHarness } from "../tests/utils.ts";
import { GlobalConfig } from "../src/Domain/Config.ts";

const DEFAULT_TAGS =
  "not appendobject and not bucket_policy and not copy and not cors and not encryption and not fails_strict_rfc2616 and not iam_tenant and not iam_user and not iam_account and not lifecycle and not object_lock and not policy and not policy_status and not s3select and not s3website and not sse_s3 and not tagging and not test_of_sts and not user_policy and not versioning and not webidentity_test";

// To run only copy tests: S3TEST_TAGS=copy ./x/s3-tests.ts  or  ./x/s3-tests.ts -- -m copy

function getRustfsConfig(): GlobalConfig {
  return {
    backends: {
      rustfs: {
        protocol: "s3",
        endpoint: "http://localhost:9100",
        region: "us-east-1",
        credentials: {
          accessKeyId: "minioadmin",
          secretAccessKey: "minioadmin",
        },
        buckets: "*",
      },
    },
  };
}

const getSwiftConfig = () =>
  Effect.gen(function* () {
    const authUrl = yield* Config.string("HERALD_SWIFTTEST_AUTH_URL").pipe(
      Config.orElse(() => Config.string("OS_AUTH_URL")),
      Config.withDefault("http://localhost:8081/auth/v1.0"),
      Config.option,
    );

    const username = yield* Config.string("HERALD_SWIFTTEST_OS_USERNAME").pipe(
      Config.orElse(() => Config.string("TF_VAR_OS_USERNAME")),
      Config.orElse(() => Config.string("OS_USERNAME")),
      Config.withDefault("test:tester"),
      Config.option,
    );
    const password = yield* Config.string("HERALD_SWIFTTEST_OS_PASSWORD").pipe(
      Config.orElse(() => Config.string("TF_VAR_OS_PASSWORD")),
      Config.orElse(() => Config.string("OS_PASSWORD")),
      Config.withDefault("testing"),
      Config.option,
    );
    const projectName = yield* Config.string("HERALD_SWIFTTEST_OS_PROJECT_NAME")
      .pipe(
        Config.orElse(() => Config.string("TF_VAR_OS_PROJECT_NAME")),
        Config.orElse(() => Config.string("OS_PROJECT_NAME")),
        Config.option,
      );
    const region = yield* Config.string("HERALD_SWIFTTEST_OS_REGION_NAME").pipe(
      Config.orElse(() => Config.string("TF_VAR_OS_REGION_NAME")),
      Config.orElse(() => Config.string("OS_REGION_NAME")),
      Config.withDefault("dc3-a"),
      Config.option,
    );

    if (
      Option.isNone(username) || Option.isNone(password) ||
      Option.isNone(authUrl)
    ) {
      return Option.none();
    }

    const config: GlobalConfig = {
      backends: {
        swift: {
          protocol: "swift",
          auth_url: authUrl.value,
          region: Option.getOrUndefined(region),
          credentials: {
            username: username.value,
            password: password.value,
            project_name: Option.getOrUndefined(projectName),
            user_domain_name: "Default",
            project_domain_name: "Default",
          },
          buckets: "*",
        },
      },
    };
    return Option.some(config);
  });

const program = Effect.gen(function* () {
  console.log("Program started");
  const __dirname = path.dirname(path.fromFileUrl(import.meta.url));
  const s3TestsDir = path.resolve(__dirname, "../s3-tests");

  // Parse filtering arguments and flags
  const rawArgs = [...Deno.args];
  const noAbort = rawArgs.includes("--no-abort") ||
    Deno.env.get("S3TEST_NO_ABORT") === "true";
  const updatePassList = rawArgs.includes("--update-pass-list");
  // A baseline run for regenerating the pass list must see all results.
  const effectiveNoAbort = noAbort || updatePassList;

  let backend = "rustfs";
  const backendIdx = rawArgs.indexOf("--backend");
  if (backendIdx !== -1) {
    backend = rawArgs[backendIdx + 1];
    rawArgs.splice(backendIdx, 2);
  }

  const pytestArgsFromCli = rawArgs.filter(
    (arg) => arg !== "--no-abort" && arg !== "--update-pass-list",
  );

  const proxyLogName = backend === "swift"
    ? "herald-proxy-swift.log"
    : "herald-proxy.log";
  const proxyLogPath = path.join(s3TestsDir, proxyLogName);

  // Initialize config based on backend
  let activeConfig: GlobalConfig;
  let s3AccessKey = "minioadmin";
  let s3SecretKey = "minioadmin";

  if (backend === "swift") {
    const swiftConfig = yield* getSwiftConfig();
    if (Option.isNone(swiftConfig)) {
      return yield* Effect.fail(
        new Error("Swift credentials missing. Run with infisical."),
      );
    }
    activeConfig = swiftConfig.value;
    // For Swift backend, Herald doesn't check S3 credentials,
    // but s3-tests needs them to sign requests.
    // We use minioadmin/minioadmin because that's what the test harness mock HeraldConfig uses.
    s3AccessKey = "minioadmin";
    s3SecretKey = "minioadmin";
  } else {
    activeConfig = getRustfsConfig();
  }

  console.log("Creating file logger for proxy...");
  // Create a file logger for the proxy
  const proxyLogFile = yield* Effect.tryPromise(() =>
    Deno.open(proxyLogPath, { write: true, create: true, truncate: true })
  );

  yield* Effect.addFinalizer(() =>
    Effect.tryPromise({
      try: () => Promise.resolve(proxyLogFile.close()),
      catch: (e) => new Error(`Failed to close proxy log file: ${e}`),
    }).pipe(Effect.orDie)
  );

  // Bootstrap: write one line so we know the file path is correct and writable
  yield* Effect.sync(() => {
    Deno.writeTextFileSync(
      proxyLogPath,
      `${
        new Date().toISOString()
      } Herald proxy log started (path=${proxyLogPath})\n`,
      { append: true },
    );
  });

  const minLogLevel = LogLevel.Debug;

  // Create a custom logging layer that writes to file synchronously.
  // Merge order: minimumLogLevel first so the runtime accepts Debug, then our
  // file logger so it is the one used (not the default console).
  const fileLogger = Logger.replace(
    Logger.defaultLogger,
    Logger.make(({ message, logLevel: currentLogLevel }) => {
      const timestamp = new Date().toISOString();
      const level = currentLogLevel.label;
      const msg = typeof message === "string"
        ? message
        : JSON.stringify(message);
      const logLine = `${timestamp} level=${level} ${msg}\n`;
      try {
        Deno.writeTextFileSync(proxyLogPath, logLine, { append: true });
      } catch (e) {
        console.error(`Failed to write to proxy log: ${e}`);
      }
    }),
  );
  const FileLoggingLive = Layer.mergeAll(
    Logger.minimumLogLevel(minLogLevel),
    fileLogger,
  ) as Layer.Layer<never, never, never>;

  // Provide the file logger to the test harness (the proxy)
  const h = yield* makeTestHarness(activeConfig, FileLoggingLive);

  const port = new URL(h.proxyUrl).port;

  // Prove the file logger works in this process (writes to herald-proxy.log)
  yield* Effect.logDebug(`Herald proxy listening on port ${port}`).pipe(
    Effect.provide(FileLoggingLive),
  );

  // Parse remaining filtering arguments
  const tags = Deno.env.get("S3TEST_TAGS") ?? DEFAULT_TAGS;
  const pytestArgsEnv = Deno.env.get("S3TEST_PYTEST_ARGS") ?? "";
  const pytestArgsFromEnv = pytestArgsEnv ? pytestArgsEnv.split(/\s+/) : [];

  const pytestArgs = [...pytestArgsFromEnv, ...pytestArgsFromCli];

  return yield* (Effect.gen(function* () {
    // We use console.log for harness output to avoid them going to the proxy log file
    console.log(
      `Starting Herald (${colors.cyan(backend)} backend) on port ${
        colors.cyan(port)
      }`,
    );
    console.log(`Proxy logs: ${colors.gray(proxyLogPath)}`);

    const confContent = `[DEFAULT]
host = 127.0.0.1
port = ${port}
is_secure = no

[fixtures]
bucket prefix = herald-${backend}-{random}-

[s3 main]
# Herald presents the access key id as the canonical owner identity, so the
# main user's id/display_name must match its access_key for ACL assertions.
user_id = minioadmin
display_name = minioadmin
email = main@example.com
access_key = minioadmin
secret_key = minioadmin

[s3 alt]
user_id = alt
display_name = alt
email = alt@example.com
access_key = alt
secret_key = alt

[s3 tenant]
user_id = tenant
display_name = tenant
email = tenant@example.com
access_key = tenant
secret_key = tenant
tenant = testx

[iam]
email = iam@example.com
user_id = iam
access_key = iam
secret_key = iam
display_name = iam

[iam root]
access_key = iam_root
secret_key = iam_root
user_id = iam_root
email = iam_root@example.com

[iam alt root]
access_key = iam_alt_root
secret_key = iam_alt_root
user_id = iam_alt_root
email = iam_alt_root@example.com
`;

    const confPath = yield* Effect.promise(() =>
      Deno.makeTempFile({ suffix: ".conf" })
    );
    yield* Effect.promise(() => Deno.writeTextFile(confPath, confContent));

    const logName = backend === "swift" ? "s3-tests-swift.log" : "s3-tests.log";
    const logPath = path.join(s3TestsDir, logName);

    console.log(`s3-tests directory: ${colors.gray(s3TestsDir)}`);
    console.log(`Log file: ${colors.gray(logPath)}`);

    // Ensure we have a virtual environment
    const venvPath = path.join(s3TestsDir, ".venv");
    const venvExists = yield* Effect.tryPromise(() =>
      Deno.stat(venvPath).then(() => true).catch(() => false)
    );

    if (!venvExists) {
      console.log(colors.yellow("Creating Python virtual environment..."));
      yield* Effect.tryPromise(() => $`uv venv --python 3.11`.cwd(s3TestsDir));
    }

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

    console.log(
      `Running s3-tests against Herald on port ${colors.cyan(port)}...`,
    );
    if (tags) console.log(`${colors.gray("Tags:")} ${tags}`);
    if (pytestArgs.length > 0) {
      console.log(
        `${colors.gray("Additional pytest args:")} ${pytestArgs.join(" ")}`,
      );
    }
    if (effectiveNoAbort) {
      console.log(colors.yellow("Abort on ERROR disabled (--no-abort)"));
    }
    if (updatePassList) {
      console.log(
        colors.yellow(
          "Regenerating pass list from this run (--update-pass-list)",
        ),
      );
    }

    // Build command arguments
    const cmdArgs = [
      "-v",
      "--tb=short",
    ];

    // Backend-specific junit file so parallel rustfs/swift runs (as in CI)
    // do not overwrite each other's results, mirroring the per-backend
    // s3-tests.log / herald-proxy.log naming.
    const junitXmlName = backend === "swift"
      ? "junit-swift.xml"
      : "junit-rustfs.xml";
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
        // The s3-tests teardown calls IAM ListRoles against the S3 endpoint,
        // which Herald doesn't implement (500). boto3's default retry/backoff
        // on that 500 burned ~8s per test (~20x the whole suite). One attempt
        // keeps failures fast; passing tests are unaffected.
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
        let collectedInfo = "";
        let failedCount = 0;
        let errorCount = 0;
        let skippedCount = 0;
        let lastResultTime = Date.now();
        const seenTests = new Set<string>();
        const passedTests = new Set<string>();
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
              passedTests.add(testName);
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
              if (!effectiveNoAbort) {
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

            if (!effectiveNoAbort) {
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

        // Hard timeout: a hung pytest (or proxy deadlock) must fail the job
        // with a clear message instead of hanging CI for hours. The suite
        // takes ~6-9 min per backend; 25 min is generous.
        const HARD_TIMEOUT_MS = 25 * 60 * 1000;
        const timeoutPromise = new Promise<"timeout">((resolve) => {
          setTimeout(() => {
            console.error(
              colors.red(
                `\nHard timeout after ${
                  HARD_TIMEOUT_MS / 60000
                } min — killing pytest.`,
              ),
            );
            child.kill("SIGKILL");
            resolve("timeout");
          }, HARD_TIMEOUT_MS);
        });

        // Heartbeat: if pytest goes silent for 5 min, say so (points at the
        // test that's stuck) instead of looking like a dead job.
        const heartbeat = setInterval(() => {
          const idle = Date.now() - lastResultTime;
          if (idle > 5 * 60 * 1000) {
            console.error(
              colors.yellow(
                `\nNo test output for ${Math.round(idle / 60000)} min (last: ${
                  currentTestName || "startup"
                }).`,
              ),
            );
          }
        }, 60 * 1000);

        const raceResult = await Promise.race([
          Promise.allSettled([
            child,
            streamToLogAndConsole(child.stdout()),
            streamToLogAndConsole(child.stderr()),
          ]),
          timeoutPromise,
        ]);

        clearInterval(heartbeat);

        Deno.removeSignalListener("SIGINT", sigintHandler);

        if (raceResult === "timeout") {
          return {
            code: 124,
            counts: {
              tests: seenTests.size,
              failures: failedCount,
              errors: errorCount,
              skipped: skippedCount,
              passedNames: Array.from(passedTests),
              time: undefined,
              failedNames: Array.from(failedTests),
              errorNames: Array.from(errorTests),
            },
            collectedInfo: "",
            shouldAbort: true,
            abortReason: `Hard timeout after ${HARD_TIMEOUT_MS / 60000} min`,
          };
        }

        const [procResult] = raceResult;

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
          passedNames: string[];
          failedNames: string[];
          errorNames: string[];
        } | null = null;

        try {
          const junitXml = await Deno.readTextFile(junitXmlPath);
          const getAttr = (name: string) => {
            const match = junitXml.match(new RegExp(`${name}="([\\d.]+)"`));
            return match ? parseFloat(match[1]) : 0;
          };

          const passedNames: string[] = [];
          const failedNames: string[] = [];
          const errorNames: string[] = [];

          const testcaseMatches = junitXml.matchAll(
            /<testcase classname="([^"]+)" name="([^"]+)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g,
          );
          for (const match of testcaseMatches) {
            // JUnit classnames are dotted ("s3tests.functional.test_s3"); the
            // pass list uses pytest nodeids ("s3tests/functional/test_s3.py::…").
            const fullName = `${match[1].replaceAll(".", "/")}.py::${match[2]}`;
            // Passing tests serialize as self-closing <testcase …/> (group 4
            // undefined); failures/errors/skips have inner content.
            const content = match[4] ?? "";
            if (content.includes("<failure")) failedNames.push(fullName);
            if (content.includes("<error")) errorNames.push(fullName);
            if (
              !content.includes("<failure") && !content.includes("<error") &&
              !content.includes("<skipped")
            ) {
              passedNames.push(fullName);
            }
          }

          junitData = {
            tests: Math.floor(getAttr("tests")),
            failures: Math.floor(getAttr("failures")),
            errors: Math.floor(getAttr("errors")),
            skipped: Math.floor(getAttr("skipped")),
            time: getAttr("time"),
            passedNames,
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
          passedNames: Array.from(passedTests),
          time: undefined,
          failedNames: Array.from(failedTests),
          errorNames: Array.from(errorTests),
        };

        return {
          code: exitCode,
          counts: finalCounts,
          collectedInfo,
          shouldAbort,
          abortReason,
        };
      },
      catch: (e) => new Error(`Failed to run pytest: ${e}`),
    });

    if (result.collectedInfo) {
      console.log(colors.gray(result.collectedInfo));
    }

    const {
      tests,
      failures,
      errors,
      skipped,
      time,
      passedNames,
      failedNames,
      errorNames,
    } = result.counts;
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
    // --- Pass-list regression gate ---
    // s3-tests doesn't fully pass against Herald, so CI can't require a green
    // suite. Instead we check in a per-backend list of known-passing tests and
    // fail only if any of THOSE regress. Known failures are tolerated.
    const passListPath = path.join(__dirname, `s3-tests-pass-${backend}.txt`);
    const passListContent = yield* Effect.tryPromise(() =>
      Deno.readTextFile(passListPath)
    ).pipe(Effect.catchAll(() => Effect.succeed(null)));
    let passList: Set<string> | null = null;
    if (passListContent !== null) {
      passList = new Set(
        passListContent.split("\n").map((l) => l.trim()).filter((l) =>
          l && !l.startsWith("#")
        ),
      );
      console.log(
        colors.gray(
          `Pass list: ${passList.size} known-passing tests (${passListPath})`,
        ),
      );
    } else {
      console.log(
        colors.yellow(
          `No pass list found at ${passListPath} — failing on any failure.`,
        ),
      );
    }

    if (updatePassList && passList !== null) {
      // Guard against regenerating from a filtered/partial run, which would
      // silently truncate the list. The full tag-selected suite is 618 tests.
      if (tests < 500) {
        yield* Effect.fail(
          new Error(
            `Refusing to update pass list: only ${tests} tests ran (need >= 500). ` +
              `A partial run would truncate the list.`,
          ),
        );
      }
      const gitResult = yield* Effect.tryPromise(() =>
        $`git -C ${s3TestsDir} rev-parse --short HEAD`.noThrow().quiet()
      );
      const submoduleCommit = gitResult.stdout.trim();
      const header = [
        `# s3-tests pass list for the ${backend} backend (auto-generated).`,
        `# One pytest nodeid per line. CI fails if any of these regress.`,
        `# Generated from s3-tests submodule ${submoduleCommit} on ${
          new Date().toISOString()
        }`,
        `# Regenerate: ./x/s3-tests.ts --backend ${backend} --update-pass-list`,
      ];
      const sorted = [...new Set(passedNames)].sort();
      yield* Effect.tryPromise(() =>
        Deno.writeTextFile(
          passListPath,
          header.join("\n") + "\n" + sorted.join("\n") + "\n",
        )
      );
      console.log(
        colors.green(
          `\nWrote ${sorted.length} passing tests to ${passListPath}`,
        ),
      );
    } else if (passList !== null) {
      const regressed = [...new Set([...failedNames, ...errorNames])].filter((
        n,
      ) => passList.has(n));
      if (regressed.length > 0) {
        console.error(
          colors.red(
            `\nRegression: ${regressed.length} previously-passing test(s) failed:`,
          ),
        );
        for (const name of regressed) {
          console.error(`  ${colors.red("-")} ${name}`);
        }
        yield* Effect.fail(
          new Error(
            `${regressed.length} previously-passing test(s) regressed.`,
          ),
        );
      }
      const newlyPassing = passedNames.filter((n) => !passList.has(n));
      if (newlyPassing.length > 0) {
        console.log(
          colors.green(
            `\n${newlyPassing.length} newly-passing test(s) (not in pass list):`,
          ),
        );
        for (const name of newlyPassing.slice(0, 20)) {
          console.log(`  ${colors.green("+")} ${name}`);
        }
        if (newlyPassing.length > 20) {
          console.log(`  ... and ${newlyPassing.length - 20} more`);
        }
        console.log(
          colors.gray(
            `Run with --update-pass-list to fold them into the pass list.`,
          ),
        );
      }
    }

    // With a pass list (or in update mode) known failures/errors are tolerated;
    // the regression check above is the gate. Without one, any failure fails.
    const gateActive = passList !== null || updatePassList;

    if (tests === 0) {
      yield* Effect.fail(
        new Error("No tests ran — pytest collection or startup failure."),
      );
    }

    if (result.shouldAbort && result.abortReason) {
      yield* Effect.fail(
        new Error(
          `Aborted due to ERROR: ${result.abortReason || "Test Error"}`,
        ),
      );
    }

    if (errors > 0 && !gateActive) {
      yield* Effect.fail(new Error(`s3-tests finished with errors.`));
    }

    if ((failures > 0 || result.code !== 0) && !gateActive) {
      yield* Effect.fail(
        new Error(`s3-tests finished with failures (code ${result.code}).`),
      );
    }

    console.log(colors.green(`\n✓ s3-tests completed successfully.`));
  }).pipe(
    Effect.provide(Logger.minimumLogLevel(minLogLevel)),
  ));
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

  Effect.runPromiseExit(program.pipe(Effect.scoped)).then((exit) => {
    if (Exit.isFailure(exit)) {
      // JSON.stringify on an Error yields "{}" (message is non-enumerable),
      // so extract a descriptive message from the Cause instead.
      const failure = Cause.failureOption(exit.cause);
      const message = failure._tag === "Some" && failure.value instanceof Error
        ? failure.value.message
        : Cause.pretty(exit.cause);
      console.error(colors.red(`s3-tests failed: ${message}`));
      Deno.exit(1);
    }
  }).catch((e) => {
    console.error(colors.red(`Unhandled error: ${e}`));
    Deno.exit(1);
  });
}
