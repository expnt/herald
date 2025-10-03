import { assertEquals } from "std/assert";

Deno.test("CORS - OPTIONS preflight request without Origin header", async () => {
  const request = new Request("http://localhost:8000/test", {
    method: "OPTIONS",
    headers: {
      "Host": "localhost:8000",
    },
  });

  const response = await fetch(request);

  assertEquals(response.status, 200);
  assertEquals(response.headers.get("Access-Control-Allow-Origin"), "*");
  assertEquals(
    response.headers.get("Access-Control-Allow-Methods"),
    "GET, POST, PUT, DELETE, HEAD, OPTIONS",
  );
  assertEquals(
    response.headers.get("Access-Control-Allow-Headers"),
    "Content-Type, Authorization, X-Amz-Content-Sha256, X-Amz-Date, X-Amz-Security-Token, X-Amz-User-Agent, X-Amz-Target, X-Amz-Version, X-Amz-Authorization",
  );
  assertEquals(response.headers.get("Access-Control-Max-Age"), "86400");
  await response.text(); // Consume response body
});

Deno.test("CORS - OPTIONS preflight request with Origin header", async () => {
  const request = new Request("http://localhost:8000/test", {
    method: "OPTIONS",
    headers: {
      "Host": "localhost:8000",
      "Origin": "https://example.com",
    },
  });

  const response = await fetch(request);

  assertEquals(response.status, 200);
  assertEquals(
    response.headers.get("Access-Control-Allow-Origin"),
    "https://example.com",
  );
  assertEquals(
    response.headers.get("Access-Control-Allow-Methods"),
    "GET, POST, PUT, DELETE, HEAD, OPTIONS",
  );
  assertEquals(
    response.headers.get("Access-Control-Allow-Headers"),
    "Content-Type, Authorization, X-Amz-Content-Sha256, X-Amz-Date, X-Amz-Security-Token, X-Amz-User-Agent, X-Amz-Target, X-Amz-Version, X-Amz-Authorization",
  );
  assertEquals(response.headers.get("Access-Control-Max-Age"), "86400");
  await response.text(); // Consume response body
});

Deno.test("CORS - GET request without Origin header", async () => {
  const request = new Request("http://localhost:8000/health-check", {
    method: "GET",
    headers: {
      "Host": "localhost:8000",
    },
  });

  const response = await fetch(request);

  assertEquals(response.status, 200);
  assertEquals(response.headers.get("Access-Control-Allow-Origin"), "*");
  assertEquals(
    response.headers.get("Access-Control-Allow-Credentials"),
    "true",
  );
  assertEquals(await response.text(), "Ok");
});

Deno.test("CORS - GET request with Origin header", async () => {
  const request = new Request("http://localhost:8000/health-check", {
    method: "GET",
    headers: {
      "Host": "localhost:8000",
      "Origin": "https://myapp.com",
    },
  });

  const response = await fetch(request);

  assertEquals(response.status, 200);
  assertEquals(
    response.headers.get("Access-Control-Allow-Origin"),
    "https://myapp.com",
  );
  assertEquals(
    response.headers.get("Access-Control-Allow-Credentials"),
    "true",
  );
  assertEquals(await response.text(), "Ok");
});

Deno.test("CORS - S3 bucket request with Origin header", async () => {
  const request = new Request("http://localhost:8000/test-bucket", {
    method: "GET",
    headers: {
      "Host": "localhost:8000",
      "Origin": "https://s3-client.example.com",
    },
  });

  const response = await fetch(request);

  assertEquals(
    response.headers.get("Access-Control-Allow-Origin"),
    "https://s3-client.example.com",
  );
  assertEquals(
    response.headers.get("Access-Control-Allow-Credentials"),
    "true",
  );
  await response.text(); // Consume response body
});

Deno.test("CORS - POST request with Origin header", async () => {
  const request = new Request("http://localhost:8000/test-bucket/object", {
    method: "POST",
    headers: {
      "Host": "localhost:8000",
      "Origin": "https://uploader.example.com",
      "Content-Type": "application/octet-stream",
    },
  });

  const response = await fetch(request);

  assertEquals(
    response.headers.get("Access-Control-Allow-Origin"),
    "https://uploader.example.com",
  );
  assertEquals(
    response.headers.get("Access-Control-Allow-Credentials"),
    "true",
  );
  await response.text(); // Consume response body
});

Deno.test("CORS - PUT request with Origin header", async () => {
  const request = new Request("http://localhost:8000/test-bucket/object", {
    method: "PUT",
    headers: {
      "Host": "localhost:8000",
      "Origin": "https://uploader.example.com",
      "Content-Type": "application/octet-stream",
    },
  });

  const response = await fetch(request);

  assertEquals(
    response.headers.get("Access-Control-Allow-Origin"),
    "https://uploader.example.com",
  );
  assertEquals(
    response.headers.get("Access-Control-Allow-Credentials"),
    "true",
  );
  await response.text(); // Consume response body
});

Deno.test("CORS - DELETE request with Origin header", async () => {
  const request = new Request("http://localhost:8000/test-bucket/object", {
    method: "DELETE",
    headers: {
      "Host": "localhost:8000",
      "Origin": "https://manager.example.com",
    },
  });

  const response = await fetch(request);

  assertEquals(
    response.headers.get("Access-Control-Allow-Origin"),
    "https://manager.example.com",
  );
  assertEquals(
    response.headers.get("Access-Control-Allow-Credentials"),
    "true",
  );
  await response.text(); // Consume response body
});

Deno.test("CORS - Empty origin header should default to *", async () => {
  const request = new Request("http://localhost:8000/test", {
    method: "OPTIONS",
    headers: {
      "Host": "localhost:8000",
      "Origin": "",
    },
  });

  const response = await fetch(request);

  assertEquals(response.status, 200);
  assertEquals(response.headers.get("Access-Control-Allow-Origin"), "*");
  await response.text(); // Consume response body
});
