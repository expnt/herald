import {
  assertEquals,
  assertThrows,
} from "std/assert";
import { extractRequestInfo } from "./s3.ts";
import { urlFormatStyle } from "./types.ts";
import { HeraldError } from "../types/http-exception.ts";

// Helper function to create a mock Request with host header
function createMockRequest(url: string, host?: string): Request {
  const headers = new Headers();
  if (host) {
    headers.set("host", host);
  }
  return new Request(url, { headers });
}

// Test extractRequestInfo function which internally uses getUrlFormat
Deno.test("extractRequestInfo - IP addresses should return Path style", () => {
  const testCases = [
    { url: "http://192.168.1.1/bucket/object", host: "192.168.1.1" },
    { url: "http://127.0.0.1:8000/bucket/object", host: "127.0.0.1:8000" },
    { url: "http://10.0.0.1/bucket/object", host: "10.0.0.1" },
    { url: "http://[::1]/bucket/object", host: "[::1]" },
    { url: "http://[2001:db8::1]/bucket/object", host: "[2001:db8::1]" },
  ];

  for (const testCase of testCases) {
    const request = createMockRequest(testCase.url, testCase.host);
    const result = extractRequestInfo(request);
    assertEquals(
      result.urlFormat,
      urlFormatStyle.def.entries.Path,
      `IP address ${testCase.host} should return Path style`,
    );
    assertEquals(result.bucket, "bucket");
    assertEquals(result.objectKey, "object");
  }
});

Deno.test("extractRequestInfo - localhost should return Path style", () => {
  const testCases = [
    { url: "http://localhost/bucket/object", host: "localhost" },
    { url: "http://localhost:8000/bucket/object", host: "localhost:8000" },
  ];

  for (const testCase of testCases) {
    const request = createMockRequest(testCase.url, testCase.host);
    const result = extractRequestInfo(request);
    assertEquals(
      result.urlFormat,
      urlFormatStyle.def.entries.Path,
      `localhost ${testCase.host} should return Path style`,
    );
    assertEquals(result.bucket, "bucket");
    assertEquals(result.objectKey, "object");
  }
});

Deno.test("extractRequestInfo - virtual hosted style domains", () => {
  const testCases = [
    {
      url: "http://mybucket.s3.amazonaws.com/object",
      host: "mybucket.s3.amazonaws.com",
    },
    {
      url: "http://test-bucket.s3.amazonaws.com/path/to/object",
      host: "test-bucket.s3.amazonaws.com",
    },
    {
      url: "http://bucket123.s3.us-east-1.amazonaws.com/object",
      host: "bucket123.s3.us-east-1.amazonaws.com",
    },
  ];

  for (const testCase of testCases) {
    const request = createMockRequest(testCase.url, testCase.host);
    const result = extractRequestInfo(request);
    assertEquals(
      result.urlFormat,
      urlFormatStyle.def.entries.VirtualHosted,
      `Domain ${testCase.host} should return VirtualHosted style`,
    );
    assertEquals(result.bucket, testCase.host.split(".")[0]);
  }
});

Deno.test("extractRequestInfo - path style domains", () => {
  const testCases = [
    { url: "http://s3.amazonaws.com/bucket/object", host: "s3.amazonaws.com" },
    {
      url: "http://herald.example.com/bucket/object",
      host: "herald.example.com",
    },
    {
      url: "http://storage.example.com/bucket/object",
      host: "storage.example.com",
    },
    { url: "http://www.example.com/bucket/object", host: "www.example.com" },
    { url: "http://api.example.com/bucket/object", host: "api.example.com" },
  ];

  for (const testCase of testCases) {
    const request = createMockRequest(testCase.url, testCase.host);
    const result = extractRequestInfo(request);
    assertEquals(
      result.urlFormat,
      urlFormatStyle.def.entries.Path,
      `Domain ${testCase.host} should return Path style`,
    );
    assertEquals(result.bucket, "bucket");
    assertEquals(result.objectKey, "object");
  }
});

Deno.test("extractRequestInfo - subdomain with forcePathStyle should return Path style", () => {
  // This is the main issue: subdomains should be able to use path style
  // when forcePathStyle is true, but current implementation assumes subdomains
  // are always virtual hosted style
  const testCases = [
    {
      url: "http://storage.example.com/bucket/object",
      host: "storage.example.com",
    },
    { url: "http://s3.example.com/bucket/object", host: "s3.example.com" },
    {
      url: "http://herald.example.com/bucket/object",
      host: "herald.example.com",
    },
    {
      url: "http://minio.example.com/bucket/object",
      host: "minio.example.com",
    },
  ];

  for (const testCase of testCases) {
    const request = createMockRequest(testCase.url, testCase.host);
    const result = extractRequestInfo(request);
    assertEquals(
      result.urlFormat,
      urlFormatStyle.def.entries.Path,
      `Subdomain ${testCase.host} should return Path style when forcePathStyle is true`,
    );
    assertEquals(result.bucket, "bucket");
    assertEquals(result.objectKey, "object");
  }
});

Deno.test("extractRequestInfo - missing host header should throw error", () => {
  const request = createMockRequest("http://example.com/bucket/object");
  // No host header set

  assertThrows(
    () => extractRequestInfo(request),
    HeraldError,
    "Invalid request: http://example.com/bucket/object",
  );
});

Deno.test("extractRequestInfo - complete request", () => {
  const request = createMockRequest(
    "http://mybucket.s3.amazonaws.com/path/to/object?param1=value1&param2=value2",
    "mybucket.s3.amazonaws.com",
  );
  const requestInfo = extractRequestInfo(request);

  assertEquals(requestInfo.bucket, "mybucket");
  assertEquals(requestInfo.objectKey, "path/to/object");
  assertEquals(requestInfo.urlFormat, urlFormatStyle.def.entries.VirtualHosted);
  assertEquals(requestInfo.method, "GET");
  assertEquals(requestInfo.queryParams.param1, ["value1"]);
  assertEquals(requestInfo.queryParams.param2, ["value2"]);
});

Deno.test("extractRequestInfo - path style request", () => {
  const request = createMockRequest(
    "http://s3.amazonaws.com/mybucket/path/to/object",
    "s3.amazonaws.com",
  );
  const requestInfo = extractRequestInfo(request);

  assertEquals(requestInfo.bucket, "mybucket");
  assertEquals(requestInfo.objectKey, "path/to/object");
  assertEquals(requestInfo.urlFormat, urlFormatStyle.def.entries.Path);
  assertEquals(requestInfo.method, "GET");
});

Deno.test("extractRequestInfo - POST request", () => {
  const request = new Request("http://s3.amazonaws.com/mybucket/object", {
    method: "POST",
    headers: { "host": "s3.amazonaws.com" },
  });
  const requestInfo = extractRequestInfo(request);

  assertEquals(requestInfo.method, "POST");
});

Deno.test("extractRequestInfo - PUT request", () => {
  const request = new Request("http://s3.amazonaws.com/mybucket/object", {
    method: "PUT",
    headers: { "host": "s3.amazonaws.com" },
  });
  const requestInfo = extractRequestInfo(request);

  assertEquals(requestInfo.method, "PUT");
});

Deno.test("extractRequestInfo - DELETE request", () => {
  const request = new Request("http://s3.amazonaws.com/mybucket/object", {
    method: "DELETE",
    headers: { "host": "s3.amazonaws.com" },
  });
  const requestInfo = extractRequestInfo(request);

  assertEquals(requestInfo.method, "DELETE");
});

Deno.test("extractRequestInfo - HEAD request", () => {
  const request = new Request("http://s3.amazonaws.com/mybucket/object", {
    method: "HEAD",
    headers: { "host": "s3.amazonaws.com" },
  });
  const requestInfo = extractRequestInfo(request);

  assertEquals(requestInfo.method, "HEAD");
});

Deno.test("extractRequestInfo - invalid method should throw error", () => {
  const request = new Request("http://s3.amazonaws.com/mybucket/object", {
    method: "INVALID",
    headers: { "host": "s3.amazonaws.com" },
  });

  assertThrows(() => extractRequestInfo(request), Error);
});

// Test cases for the specific issue: subdomain hosting with forcePathStyle
Deno.test("Subdomain hosting with forcePathStyle - Issue reproduction", () => {
  // These test cases demonstrate the current issue where subdomains
  // are incorrectly assumed to be virtual hosted style even when
  // forcePathStyle should be true

  const subdomainTestCases = [
    {
      description: "Storage subdomain should use path style",
      url: "http://storage.example.com/my-bucket/my-object",
      host: "storage.example.com",
      expectedFormat: urlFormatStyle.def.entries.Path,
      expectedBucket: "my-bucket",
      expectedObjectKey: "my-object",
    },
    {
      description: "S3 subdomain should use path style",
      url: "http://s3.example.com/my-bucket/my-object",
      host: "s3.example.com",
      expectedFormat: urlFormatStyle.def.entries.Path,
      expectedBucket: "my-bucket",
      expectedObjectKey: "my-object",
    },
    {
      description: "Herald subdomain should use path style",
      url: "http://herald.example.com/my-bucket/my-object",
      host: "herald.example.com",
      expectedFormat: urlFormatStyle.def.entries.Path,
      expectedBucket: "my-bucket",
      expectedObjectKey: "my-object",
    },
  ];

  for (const testCase of subdomainTestCases) {
    const request = createMockRequest(testCase.url, testCase.host);
    const requestInfo = extractRequestInfo(request);

    assertEquals(
      requestInfo.urlFormat,
      testCase.expectedFormat,
      `${testCase.description}: URL format should be Path`,
    );
    assertEquals(
      requestInfo.bucket,
      testCase.expectedBucket,
      `${testCase.description}: Bucket name should be extracted correctly`,
    );
    assertEquals(
      requestInfo.objectKey,
      testCase.expectedObjectKey,
      `${testCase.description}: Object key should be extracted correctly`,
    );
  }
});

// ============================================================================
// COMPREHENSIVE TESTS FOR ALL EXTRACTION FUNCTIONS
// ============================================================================

// Tests for extractMethod function (tested through extractRequestInfo)
Deno.test("extractMethod - Valid HTTP methods", () => {
  const validMethods = ["GET", "POST", "PUT", "DELETE", "HEAD"];

  for (const method of validMethods) {
    const request = new Request("http://s3.amazonaws.com/bucket/object", {
      method,
      headers: { "host": "s3.amazonaws.com" },
    });
    const requestInfo = extractRequestInfo(request);
    assertEquals(
      requestInfo.method,
      method,
      `Method ${method} should be extracted correctly`,
    );
  }
});

Deno.test("extractMethod - Case insensitive method handling", () => {
  const testCases = [
    { input: "get", expected: "GET" },
    { input: "post", expected: "POST" },
    { input: "put", expected: "PUT" },
    { input: "delete", expected: "DELETE" },
    { input: "head", expected: "HEAD" },
  ];

  for (const testCase of testCases) {
    const request = new Request("http://s3.amazonaws.com/bucket/object", {
      method: testCase.input,
      headers: { "host": "s3.amazonaws.com" },
    });
    const requestInfo = extractRequestInfo(request);
    assertEquals(
      requestInfo.method,
      testCase.expected,
      `Method ${testCase.input} should be converted to ${testCase.expected}`,
    );
  }
});

Deno.test("extractMethod - Invalid methods", () => {
  // Test invalid methods that are allowed by Request constructor but not by our schema
  // Note: Most HTTP methods are forbidden by the Request constructor in Deno
  // We'll test with a method that's allowed by Request but not by our schema
  const request = new Request("http://s3.amazonaws.com/bucket/object", {
    method: "GET", // Use valid method for Request constructor
    headers: { "host": "s3.amazonaws.com" },
  });

  // Manually modify the method to test our validation
  // This simulates what would happen if an invalid method got through
  const originalMethod = request.method;
  Object.defineProperty(request, "method", {
    get: () => "INVALID",
    configurable: true,
  });

  assertThrows(() => extractRequestInfo(request), Error);

  // Restore original method
  Object.defineProperty(request, "method", {
    get: () => originalMethod,
    configurable: true,
  });
});

// Tests for extractBucketName function (tested through extractRequestInfo)
Deno.test("extractBucketName - Virtual hosted style bucket extraction", () => {
  const testCases = [
    {
      url: "http://mybucket.s3.amazonaws.com/object",
      host: "mybucket.s3.amazonaws.com",
      expectedBucket: "mybucket",
    },
    {
      url: "http://test-bucket.s3.amazonaws.com/path/to/object",
      host: "test-bucket.s3.amazonaws.com",
      expectedBucket: "test-bucket",
    },
    {
      url: "http://bucket123.s3.us-east-1.amazonaws.com/object",
      host: "bucket123.s3.us-east-1.amazonaws.com",
      expectedBucket: "bucket123",
    },
    {
      url: "http://my-bucket-name.s3.amazonaws.com/object",
      host: "my-bucket-name.s3.amazonaws.com",
      expectedBucket: "my-bucket-name",
    },
  ];

  for (const testCase of testCases) {
    const request = createMockRequest(testCase.url, testCase.host);
    const requestInfo = extractRequestInfo(request);
    assertEquals(
      requestInfo.bucket,
      testCase.expectedBucket,
      `Virtual hosted bucket ${testCase.host} should extract bucket ${testCase.expectedBucket}`,
    );
  }
});

Deno.test("extractBucketName - Path style bucket extraction", () => {
  const testCases = [
    {
      url: "http://s3.amazonaws.com/mybucket/object",
      host: "s3.amazonaws.com",
      expectedBucket: "mybucket",
    },
    {
      url: "http://storage.example.com/test-bucket/path/to/object",
      host: "storage.example.com",
      expectedBucket: "test-bucket",
    },
    {
      url: "http://localhost:8000/bucket123/object",
      host: "localhost:8000",
      expectedBucket: "bucket123",
    },
    {
      url: "http://192.168.1.1/my-bucket-name/object",
      host: "192.168.1.1",
      expectedBucket: "my-bucket-name",
    },
  ];

  for (const testCase of testCases) {
    const request = createMockRequest(testCase.url, testCase.host);
    const requestInfo = extractRequestInfo(request);
    assertEquals(
      requestInfo.bucket,
      testCase.expectedBucket,
      `Path style bucket from ${testCase.host} should extract bucket ${testCase.expectedBucket}`,
    );
  }
});

Deno.test("extractBucketName - Edge cases", () => {
  const testCases = [
    {
      description: "No bucket in path",
      url: "http://s3.amazonaws.com/",
      host: "s3.amazonaws.com",
      expectedBucket: null,
    },
    {
      description: "Empty bucket name",
      url: "http://s3.amazonaws.com//object",
      host: "s3.amazonaws.com",
      expectedBucket: "object",
    },
    {
      description: "Virtual hosted with no path",
      url: "http://mybucket.s3.amazonaws.com/",
      host: "mybucket.s3.amazonaws.com",
      expectedBucket: "mybucket",
    },
  ];

  for (const testCase of testCases) {
    const request = createMockRequest(testCase.url, testCase.host);
    const requestInfo = extractRequestInfo(request);
    assertEquals(
      requestInfo.bucket,
      testCase.expectedBucket,
      `${testCase.description}: should extract bucket ${testCase.expectedBucket}`,
    );
  }
});

// Tests for extractObjectKey function (tested through extractRequestInfo)
Deno.test("extractObjectKey - Virtual hosted style object key extraction", () => {
  const testCases = [
    {
      url: "http://mybucket.s3.amazonaws.com/object",
      host: "mybucket.s3.amazonaws.com",
      expectedObjectKey: "object",
    },
    {
      url: "http://mybucket.s3.amazonaws.com/path/to/object",
      host: "mybucket.s3.amazonaws.com",
      expectedObjectKey: "path/to/object",
    },
    {
      url: "http://mybucket.s3.amazonaws.com/folder/subfolder/file.txt",
      host: "mybucket.s3.amazonaws.com",
      expectedObjectKey: "folder/subfolder/file.txt",
    },
    {
      url: "http://mybucket.s3.amazonaws.com/",
      host: "mybucket.s3.amazonaws.com",
      expectedObjectKey: null,
    },
  ];

  for (const testCase of testCases) {
    const request = createMockRequest(testCase.url, testCase.host);
    const requestInfo = extractRequestInfo(request);
    assertEquals(
      requestInfo.objectKey,
      testCase.expectedObjectKey,
      `Virtual hosted object key from ${testCase.host} should extract ${testCase.expectedObjectKey}`,
    );
  }
});

Deno.test("extractObjectKey - Path style object key extraction", () => {
  const testCases = [
    {
      url: "http://s3.amazonaws.com/mybucket/object",
      host: "s3.amazonaws.com",
      expectedObjectKey: "object",
    },
    {
      url: "http://s3.amazonaws.com/mybucket/path/to/object",
      host: "s3.amazonaws.com",
      expectedObjectKey: "path/to/object",
    },
    {
      url: "http://storage.example.com/bucket/folder/subfolder/file.txt",
      host: "storage.example.com",
      expectedObjectKey: "folder/subfolder/file.txt",
    },
    {
      url: "http://s3.amazonaws.com/mybucket/",
      host: "s3.amazonaws.com",
      expectedObjectKey: null,
    },
    {
      url: "http://s3.amazonaws.com/mybucket",
      host: "s3.amazonaws.com",
      expectedObjectKey: null,
    },
  ];

  for (const testCase of testCases) {
    const request = createMockRequest(testCase.url, testCase.host);
    const requestInfo = extractRequestInfo(request);
    assertEquals(
      requestInfo.objectKey,
      testCase.expectedObjectKey,
      `Path style object key from ${testCase.host} should extract ${testCase.expectedObjectKey}`,
    );
  }
});

Deno.test("extractObjectKey - Special characters in object keys", () => {
  const testCases = [
    {
      url: "http://mybucket.s3.amazonaws.com/file%20with%20spaces.txt",
      host: "mybucket.s3.amazonaws.com",
      expectedObjectKey: "file%20with%20spaces.txt",
    },
    {
      url: "http://s3.amazonaws.com/mybucket/file%20with%20spaces.txt",
      host: "s3.amazonaws.com",
      expectedObjectKey: "file%20with%20spaces.txt",
    },
    {
      url: "http://mybucket.s3.amazonaws.com/folder/file+with+plus.txt",
      host: "mybucket.s3.amazonaws.com",
      expectedObjectKey: "folder/file+with+plus.txt",
    },
  ];

  for (const testCase of testCases) {
    const request = createMockRequest(testCase.url, testCase.host);
    const requestInfo = extractRequestInfo(request);
    assertEquals(
      requestInfo.objectKey,
      testCase.expectedObjectKey,
      `Object key with special characters should be extracted correctly`,
    );
  }
});

// Tests for getUrlFormat function (tested through extractRequestInfo)
Deno.test("getUrlFormat - Comprehensive virtual hosted style detection", () => {
  const testCases = [
    {
      url: "http://mybucket.s3.amazonaws.com/object",
      host: "mybucket.s3.amazonaws.com",
      expectedFormat: urlFormatStyle.def.entries.VirtualHosted,
    },
    {
      url: "http://test-bucket.s3.us-east-1.amazonaws.com/object",
      host: "test-bucket.s3.us-east-1.amazonaws.com",
      expectedFormat: urlFormatStyle.def.entries.VirtualHosted,
    },
    {
      url: "http://bucket.s3.amazon.com/object",
      host: "bucket.s3.amazon.com",
      expectedFormat: urlFormatStyle.def.entries.VirtualHosted,
    },
    {
      url: "http://mybucket.s3.example.com/object",
      host: "mybucket.s3.example.com",
      expectedFormat: urlFormatStyle.def.entries.Path,
    },
  ];

  for (const testCase of testCases) {
    const request = createMockRequest(testCase.url, testCase.host);
    const requestInfo = extractRequestInfo(request);
    assertEquals(
      requestInfo.urlFormat,
      testCase.expectedFormat,
      `Virtual hosted style should be detected for ${testCase.host}`,
    );
  }
});

Deno.test("getUrlFormat - Comprehensive path style detection", () => {
  const testCases = [
    {
      url: "http://s3.amazonaws.com/bucket/object",
      host: "s3.amazonaws.com",
      expectedFormat: urlFormatStyle.def.entries.Path,
    },
    {
      url: "http://storage.example.com/bucket/object",
      host: "storage.example.com",
      expectedFormat: urlFormatStyle.def.entries.Path,
    },
    {
      url: "http://herald.example.com/bucket/object",
      host: "herald.example.com",
      expectedFormat: urlFormatStyle.def.entries.Path,
    },
    {
      url: "http://minio.example.com/bucket/object",
      host: "minio.example.com",
      expectedFormat: urlFormatStyle.def.entries.Path,
    },
    {
      url: "http://api.example.com/bucket/object",
      host: "api.example.com",
      expectedFormat: urlFormatStyle.def.entries.Path,
    },
    {
      url: "http://www.example.com/bucket/object",
      host: "www.example.com",
      expectedFormat: urlFormatStyle.def.entries.Path,
    },
  ];

  for (const testCase of testCases) {
    const request = createMockRequest(testCase.url, testCase.host);
    const requestInfo = extractRequestInfo(request);
    assertEquals(
      requestInfo.urlFormat,
      testCase.expectedFormat,
      `Path style should be detected for ${testCase.host}`,
    );
  }
});

Deno.test("getUrlFormat - Port handling", () => {
  const testCases = [
    {
      url: "http://localhost:8000/bucket/object",
      host: "localhost:8000",
      expectedFormat: urlFormatStyle.def.entries.Path,
    },
    {
      url: "http://127.0.0.1:9000/bucket/object",
      host: "127.0.0.1:9000",
      expectedFormat: urlFormatStyle.def.entries.Path,
    },
    {
      url: "http://mybucket.s3.amazonaws.com:443/object",
      host: "mybucket.s3.amazonaws.com:443",
      expectedFormat: urlFormatStyle.def.entries.VirtualHosted,
    },
    {
      url: "http://storage.example.com:8080/bucket/object",
      host: "storage.example.com:8080",
      expectedFormat: urlFormatStyle.def.entries.Path,
    },
  ];

  for (const testCase of testCases) {
    const request = createMockRequest(testCase.url, testCase.host);
    const requestInfo = extractRequestInfo(request);
    assertEquals(
      requestInfo.urlFormat,
      testCase.expectedFormat,
      `URL format with port should be detected correctly for ${testCase.host}`,
    );
  }
});

// Tests for extractRequestInfo function - Query parameters
Deno.test("extractRequestInfo - Query parameter extraction", () => {
  const testCases: Array<{
    url: string;
    host: string;
    expectedParams: Record<string, string[]>;
  }> = [
    {
      url: "http://s3.amazonaws.com/bucket/object?param1=value1",
      host: "s3.amazonaws.com",
      expectedParams: { param1: ["value1"] },
    },
    {
      url: "http://s3.amazonaws.com/bucket/object?param1=value1&param2=value2",
      host: "s3.amazonaws.com",
      expectedParams: { param1: ["value1"], param2: ["value2"] },
    },
    {
      url: "http://s3.amazonaws.com/bucket/object?param1=value1&param1=value2",
      host: "s3.amazonaws.com",
      expectedParams: { param1: ["value1", "value2"] },
    },
    {
      url: "http://s3.amazonaws.com/bucket/object?param1=value%20with%20spaces",
      host: "s3.amazonaws.com",
      expectedParams: { param1: ["value with spaces"] },
    },
    {
      url: "http://s3.amazonaws.com/bucket/object?",
      host: "s3.amazonaws.com",
      expectedParams: {},
    },
  ];

  for (const testCase of testCases) {
    const request = createMockRequest(testCase.url, testCase.host);
    const requestInfo = extractRequestInfo(request);
    assertEquals(
      requestInfo.queryParams,
      testCase.expectedParams,
      `Query parameters should be extracted correctly for ${testCase.url}`,
    );
  }
});

Deno.test("extractRequestInfo - Complex real-world scenarios", () => {
  const testCases = [
    {
      description: "AWS S3 virtual hosted style with region",
      url:
        "http://mybucket.s3.us-west-2.amazonaws.com/path/to/file.txt?versionId=123&response-content-disposition=attachment",
      host: "mybucket.s3.us-west-2.amazonaws.com",
      expectedBucket: "mybucket",
      expectedObjectKey: "path/to/file.txt",
      expectedFormat: urlFormatStyle.def.entries.VirtualHosted,
      expectedMethod: "GET",
    },
    {
      description: "MinIO path style with custom port",
      url:
        "http://minio.example.com:9000/bucket/folder/file.json?X-Amz-Algorithm=AWS4-HMAC-SHA256",
      host: "minio.example.com:9000",
      expectedBucket: "bucket",
      expectedObjectKey: "folder/file.json",
      expectedFormat: urlFormatStyle.def.entries.Path,
      expectedMethod: "GET",
    },
    {
      description: "Herald subdomain with forcePathStyle",
      url:
        "http://herald.example.com/my-bucket/path/to/object?uploadId=abc123&partNumber=1",
      host: "herald.example.com",
      expectedBucket: "my-bucket",
      expectedObjectKey: "path/to/object",
      expectedFormat: urlFormatStyle.def.entries.Path,
      expectedMethod: "GET",
    },
    {
      description: "Local development with IP",
      url: "http://192.168.1.100:8000/test-bucket/object?debug=true",
      host: "192.168.1.100:8000",
      expectedBucket: "test-bucket",
      expectedObjectKey: "object",
      expectedFormat: urlFormatStyle.def.entries.Path,
      expectedMethod: "GET",
    },
  ];

  for (const testCase of testCases) {
    const request = createMockRequest(testCase.url, testCase.host);
    const requestInfo = extractRequestInfo(request);

    assertEquals(
      requestInfo.bucket,
      testCase.expectedBucket,
      `${testCase.description}: Bucket should be ${testCase.expectedBucket}`,
    );
    assertEquals(
      requestInfo.objectKey,
      testCase.expectedObjectKey,
      `${testCase.description}: Object key should be ${testCase.expectedObjectKey}`,
    );
    assertEquals(
      requestInfo.urlFormat,
      testCase.expectedFormat,
      `${testCase.description}: URL format should be ${testCase.expectedFormat}`,
    );
    assertEquals(
      requestInfo.method,
      testCase.expectedMethod,
      `${testCase.description}: Method should be ${testCase.expectedMethod}`,
    );
  }
});

Deno.test("extractRequestInfo - Edge cases and error conditions", () => {
  // Test with missing host header
  const requestNoHost = createMockRequest("http://example.com/bucket/object");
  assertThrows(
    () => extractRequestInfo(requestNoHost),
    HeraldError,
    "Invalid request: http://example.com/bucket/object",
  );

  // Test with invalid URL - this will fail at Request construction, not in our code
  assertThrows(
    () =>
      new Request("not-a-valid-url", {
        headers: { "host": "example.com" },
      }),
    TypeError,
    "Invalid URL: 'not-a-valid-url'",
  );

  // Test with very long paths
  const longPath = "/" + "a".repeat(1000) + "/" + "b".repeat(1000);
  const requestLongPath = createMockRequest(
    `http://s3.amazonaws.com${longPath}`,
    "s3.amazonaws.com",
  );
  const requestInfoLongPath = extractRequestInfo(requestLongPath);
  assertEquals(
    requestInfoLongPath.bucket,
    "a".repeat(1000),
    "Should handle very long bucket names",
  );
  assertEquals(
    requestInfoLongPath.objectKey,
    "b".repeat(1000),
    "Should handle very long object keys",
  );
});

Deno.test("extractRequestInfo - Unicode and international characters", () => {
  const testCases = [
    {
      url: "http://mybucket.s3.amazonaws.com/%E6%96%87%E4%BB%B6.txt",
      host: "mybucket.s3.amazonaws.com",
      expectedObjectKey: "%E6%96%87%E4%BB%B6.txt",
    },
    {
      url: "http://s3.amazonaws.com/bucket/%D1%84%D0%B0%D0%B9%D0%BB.txt",
      host: "s3.amazonaws.com",
      expectedObjectKey: "%D1%84%D0%B0%D0%B9%D0%BB.txt",
    },
    {
      url:
        "http://mybucket.s3.amazonaws.com/folder/%E6%96%87%E4%BB%B6/%D1%84%D0%B0%D0%B9%D0%BB.txt",
      host: "mybucket.s3.amazonaws.com",
      expectedObjectKey:
        "folder/%E6%96%87%E4%BB%B6/%D1%84%D0%B0%D0%B9%D0%BB.txt",
    },
  ];

  for (const testCase of testCases) {
    const request = createMockRequest(testCase.url, testCase.host);
    const requestInfo = extractRequestInfo(request);
    assertEquals(
      requestInfo.objectKey,
      testCase.expectedObjectKey,
      `Unicode object key should be extracted correctly: ${testCase.expectedObjectKey}`,
    );
  }
});
