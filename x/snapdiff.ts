#!/usr/bin/env -S deno run --allow-all

import * as path from "@std/path";
import { colors } from "cliffy/ansi/colors.ts";
import { diff } from "jest-diff";

async function main() {
  const snapFiles: string[] = [];

  async function walk(dir: string) {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isDirectory) {
        await walk(path.join(dir, entry.name));
      } else if (entry.name.endsWith(".snap")) {
        snapFiles.push(path.join(dir, entry.name));
      }
    }
  }

  try {
    await walk("tests");
  } catch {
    console.log(colors.red("No snapshots found. Run tests first."));
    Deno.exit(1);
  }

  if (snapFiles.length === 0) {
    console.log(colors.yellow("No test snapshots found."));
    return;
  }

  console.log(
    colors.bold(
      `\nComparing Baseline (MinIO) vs Proxy (Herald) snapshots...\n`,
    ),
  );

  let diffCount = 0;

  for (const snapFile of snapFiles) {
    // Import the snap file as a module
    const module = await import("file://" + path.resolve(snapFile));
    const snapshots = module.snapshot;

    const testNames = new Set<string>();
    for (const key of Object.keys(snapshots)) {
      const match = key.match(/^(Baseline|Proxy)\/(.+) (metadata|body) \d+$/);
      if (match) {
        testNames.add(match[2]);
      }
    }

    const sortedTestNames = Array.from(testNames).sort();

    for (const testName of sortedTestNames) {
      let testHasDiff = false;

      for (const component of ["metadata", "body"]) {
        const baselineKey = `Baseline/${testName} ${component} 1`;
        const proxyKey = `Proxy/${testName} ${component} 1`;

        const baselineVal = snapshots[baselineKey];
        const proxyVal = snapshots[proxyKey];

        if (baselineVal === undefined || proxyVal === undefined) {
          continue;
        }

        const d = diff(baselineVal, proxyVal, {
          expand: true,
          aAnnotation: `Baseline ${component}`,
          bAnnotation: `Proxy ${component}`,
        });

        if (
          d !== null &&
          !d.includes("Compared values have no visual difference.")
        ) {
          console.log(colors.red(`[DIFF] ${testName} (${component})`));
          console.log(d);
          testHasDiff = true;
        }
      }

      if (testHasDiff) {
        console.log("\n" + "=".repeat(80) + "\n");
        diffCount++;
      } else {
        console.log(colors.green(`[MATCH] ${testName}`));
      }
    }
  }

  if (diffCount > 0) {
    console.log(
      colors.red(
        `\nFound ${diffCount} tests with differences between Baseline and Proxy.`,
      ),
    );
  } else {
    console.log(colors.green("\nAll Baseline and Proxy snapshots match!"));
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(colors.red(`Error: ${e}`));
    Deno.exit(1);
  });
}
