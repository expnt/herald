#!/usr/bin/env -S deno run -A

/**
 * Test script to validate Swift container creation
 * This directly tests if Swift accepts container creation requests
 */

const AUTH_URL = Deno.env.get("HERALD_SWIFTTEST_AUTH_URL") ||
  Deno.env.get("OS_AUTH_URL") ||
  "http://localhost:8081/auth/v1.0";

const USERNAME = Deno.env.get("HERALD_SWIFTTEST_OS_USERNAME") ||
  Deno.env.get("TF_VAR_OS_USERNAME") ||
  Deno.env.get("OS_USERNAME") ||
  "test:tester";

const PASSWORD = Deno.env.get("HERALD_SWIFTTEST_OS_PASSWORD") ||
  Deno.env.get("TF_VAR_OS_PASSWORD") ||
  Deno.env.get("OS_PASSWORD") ||
  "testing";

console.log(`[1] Authenticating with Swift at ${AUTH_URL}`);
console.log(`    Username: ${USERNAME}`);

// Step 1: Authenticate
const authResponse = await fetch(AUTH_URL, {
  method: "GET",
  headers: {
    "X-Auth-User": USERNAME,
    "X-Auth-Key": PASSWORD,
  },
});

if (!authResponse.ok) {
  console.error(
    `[ERROR] Auth failed: ${authResponse.status} ${authResponse.statusText}`,
  );
  const body = await authResponse.text();
  console.error(`Response body: ${body}`);
  Deno.exit(1);
}

const token = authResponse.headers.get("X-Auth-Token");
const storageUrl = authResponse.headers.get("X-Storage-Url");

if (!token || !storageUrl) {
  console.error(`[ERROR] Missing auth headers`);
  console.error(`  Token: ${token ? "present" : "missing"}`);
  console.error(`  Storage URL: ${storageUrl ? "present" : "missing"}`);
  console.error(
    `  All headers:`,
    Object.fromEntries(authResponse.headers.entries()),
  );
  Deno.exit(1);
}

console.log(`[OK] Auth successful`);
console.log(
  `    Token: ${token.substring(0, 20)}... (length: ${token.length})`,
);
console.log(`    Storage URL: ${storageUrl}`);

// Step 2: Try to create a container
const testContainer = `test-swift-validate-${Date.now()}`;
const containerUrl = `${storageUrl}/${testContainer}`;

console.log(`\n[2] Creating container: ${testContainer}`);
console.log(`    Full URL: ${containerUrl}`);

const createResponse = await fetch(containerUrl, {
  method: "PUT",
  headers: {
    "X-Auth-Token": token,
  },
});

console.log(`    Response status: ${createResponse.status}`);
console.log(
  `    Response headers:`,
  Object.fromEntries(createResponse.headers.entries()),
);

const responseBody = await createResponse.text();
if (responseBody) {
  console.log(
    `    Response body (first 200 chars): ${responseBody.substring(0, 200)}`,
  );
}

if (
  createResponse.status === 201 || createResponse.status === 202 ||
  createResponse.status === 204
) {
  console.log(`[OK] Container created successfully!`);

  // Clean up: delete the container
  console.log(`\n[3] Cleaning up: deleting container`);
  const deleteResponse = await fetch(containerUrl, {
    method: "DELETE",
    headers: {
      "X-Auth-Token": token,
    },
  });
  console.log(`    Delete status: ${deleteResponse.status}`);

  Deno.exit(0);
} else {
  console.error(
    `[ERROR] Container creation failed with status ${createResponse.status}`,
  );
  Deno.exit(1);
}
