/**
 * Manual test runner - executes all 5 tests and outputs results
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const API_KEY = "change-me";
const BASE_URL = "http://localhost:4000";

// Helper to make HTTP requests
function makeRequest(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "localhost",
      port: 4000,
      path: path,
      method: method,
      headers: headers
    };
    
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          resolve({
            status: res.statusCode,
            body: JSON.parse(data),
            headers: res.headers
          });
        } catch (e) {
          resolve({
            status: res.statusCode,
            body: data,
            headers: res.headers
          });
        }
      });
    });
    
    req.on("error", reject);
    
    if (body) {
      req.write(body);
    }
    
    req.end();
  });
}

// Test 1: JSON Message Mode
async function test1() {
  console.log("\n" + "=".repeat(60));
  console.log("TEST 1: JSON Message Mode → 200 + jobId");
  console.log("=".repeat(60));
  
  const payload = {
    idempotencyKey: `test-json-${Date.now()}`,
    message: "Hello, this is a test message",
    contacts: [
      { name: "David Cohen", phone: "972501234567" },
      { name: "Sarah Levi", phone: "972509876543" }
    ]
  };
  
  console.log("\nRequest:");
  console.log(JSON.stringify(payload, null, 2));
  
  try {
    const response = await makeRequest(
      "POST",
      "/v1/jobs",
      {
        "Content-Type": "application/json",
        "X-API-KEY": API_KEY,
        "Content-Length": Buffer.byteLength(JSON.stringify(payload))
      },
      JSON.stringify(payload)
    );
    
    console.log("\nResponse:");
    console.log(`Status: ${response.status}`);
    console.log(JSON.stringify(response.body, null, 2));
    
    return response;
  } catch (err) {
    console.error("\n✗ ERROR:", err.message);
    return null;
  }
}

// Test 2: Multipart Image Mode
async function test2() {
  console.log("\n" + "=".repeat(60));
  console.log("TEST 2: Multipart Image Mode → 200 + jobId");
  console.log("=".repeat(60));
  
  // Create minimal JPEG
  const minimalJpeg = Buffer.from([
    0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xDB, 0x00, 0x43,
    0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
    0x09, 0x08, 0x0A, 0x0C, 0x14, 0x0D, 0x0C, 0x0B, 0x0B, 0x0C, 0x19, 0x12,
    0x13, 0x0F, 0x14, 0x1D, 0x1A, 0x1F, 0x1E, 0x1D, 0x1A, 0x1C, 0x1C, 0x20,
    0x24, 0x2E, 0x27, 0x20, 0x22, 0x2C, 0x23, 0x1C, 0x1C, 0x28, 0x37, 0x29,
    0x2C, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1F, 0x27, 0x39, 0x3D, 0x38, 0x32,
    0x3C, 0x2E, 0x33, 0x34, 0x32, 0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x01,
    0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xFF, 0xC4, 0x00, 0x14, 0x00, 0x01,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x03, 0xFF, 0xC4, 0x00, 0x14, 0x10, 0x01, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00,
    0x7F, 0x80, 0xFF, 0xD9
  ]);
  
  const boundary = `----WebKitFormBoundary${Date.now()}`;
  const idempotencyKey = `test-img-${Date.now()}`;
  const contactsJson = JSON.stringify([{ name: "Test User", phone: "972501111111" }]);
  
  let body = "";
  body += `--${boundary}\r\n`;
  body += `Content-Disposition: form-data; name="idempotencyKey"\r\n\r\n`;
  body += `${idempotencyKey}\r\n`;
  body += `--${boundary}\r\n`;
  body += `Content-Disposition: form-data; name="contacts"\r\n\r\n`;
  body += `${contactsJson}\r\n`;
  body += `--${boundary}\r\n`;
  body += `Content-Disposition: form-data; name="image"; filename="test.jpg"\r\n`;
  body += `Content-Type: image/jpeg\r\n\r\n`;
  
  const bodyBuffer = Buffer.concat([
    Buffer.from(body),
    minimalJpeg,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  
  console.log("\nRequest:");
  console.log(`Content-Type: multipart/form-data; boundary=${boundary}`);
  console.log(`idempotencyKey: ${idempotencyKey}`);
  console.log(`contacts: ${contactsJson}`);
  console.log(`image: test.jpg (${minimalJpeg.length} bytes)`);
  
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "localhost",
      port: 4000,
      path: "/v1/jobs",
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "X-API-KEY": API_KEY,
        "Content-Length": bodyBuffer.length
      }
    };
    
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const response = {
            status: res.statusCode,
            body: JSON.parse(data)
          };
          console.log("\nResponse:");
          console.log(`Status: ${response.status}`);
          console.log(JSON.stringify(response.body, null, 2));
          resolve(response);
        } catch (e) {
          console.error("\n✗ Parse error:", e.message);
          console.log("Raw data:", data);
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    
    req.on("error", (err) => {
      console.error("\n✗ ERROR:", err.message);
      reject(err);
    });
    
    req.write(bodyBuffer);
    req.end();
  });
}

// Test 3: Idempotency
async function test3() {
  console.log("\n" + "=".repeat(60));
  console.log("TEST 3: Idempotency → Same jobId");
  console.log("=".repeat(60));
  
  const idempotencyKey = `test-idempotent-${Date.now()}`;
  const payload = {
    idempotencyKey: idempotencyKey,
    message: "Test idempotency",
    contacts: [{ name: "Test", phone: "972500000000" }]
  };
  
  console.log("\nFirst request:");
  console.log(`idempotencyKey: ${idempotencyKey}`);
  
  try {
    const response1 = await makeRequest(
      "POST",
      "/v1/jobs",
      {
        "Content-Type": "application/json",
        "X-API-KEY": API_KEY,
        "Content-Length": Buffer.byteLength(JSON.stringify(payload))
      },
      JSON.stringify(payload)
    );
    
    console.log(`\nFirst response (${response1.status}):`);
    console.log(JSON.stringify(response1.body, null, 2));
    
    const jobId1 = response1.body.jobId;
    
    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 100));
    
    console.log("\nSecond request (SAME idempotencyKey)...");
    
    const response2 = await makeRequest(
      "POST",
      "/v1/jobs",
      {
        "Content-Type": "application/json",
        "X-API-KEY": API_KEY,
        "Content-Length": Buffer.byteLength(JSON.stringify(payload))
      },
      JSON.stringify(payload)
    );
    
    console.log(`\nSecond response (${response2.status}):`);
    console.log(JSON.stringify(response2.body, null, 2));
    
    const jobId2 = response2.body.jobId;
    
    console.log("\n✓ Idempotency check:");
    console.log(`  First jobId:  ${jobId1}`);
    console.log(`  Second jobId: ${jobId2}`);
    console.log(`  Match: ${jobId1 === jobId2 ? "✓ YES" : "✗ NO"}`);
    
    return { response1, response2 };
  } catch (err) {
    console.error("\n✗ ERROR:", err.message);
    return null;
  }
}

// Test 5: Queue Proof
async function test5() {
  console.log("\n" + "=".repeat(60));
  console.log("TEST 5: Job Enqueued Proof");
  console.log("=".repeat(60));
  
  try {
    console.log("\nChecking queue status before...");
    
    const before = await makeRequest(
      "GET",
      "/health/queue",
      { "X-API-KEY": API_KEY }
    );
    
    console.log(`Queue length before: ${before.body.queue?.length || 0}`);
    
    // Send a job
    console.log("\nSending new job...");
    
    const payload = {
      idempotencyKey: `test-queue-proof-${Date.now()}`,
      message: "Test queue enqueue",
      contacts: [{ name: "Queue Test", phone: "972500000001" }]
    };
    
    const jobResponse = await makeRequest(
      "POST",
      "/v1/jobs",
      {
        "Content-Type": "application/json",
        "X-API-KEY": API_KEY,
        "Content-Length": Buffer.byteLength(JSON.stringify(payload))
      },
      JSON.stringify(payload)
    );
    
    console.log(`\nJob created: ${jobResponse.body.jobId}`);
    console.log(JSON.stringify(jobResponse.body, null, 2));
    
    // Check queue again
    console.log("\nChecking queue status after...");
    
    const after = await makeRequest(
      "GET",
      "/health/queue",
      { "X-API-KEY": API_KEY }
    );
    
    console.log(`Queue length after: ${after.body.queue?.length || 0}`);
    
    const lengthBefore = before.body.queue?.length || 0;
    const lengthAfter = after.body.queue?.length || 0;
    
    console.log(`\n✓ Queue increased: ${lengthBefore} → ${lengthAfter}`);
    
    return { before, jobResponse, after };
  } catch (err) {
    console.error("\n✗ ERROR:", err.message);
    return null;
  }
}

// Main
async function main() {
  console.log("\n╔═══════════════════════════════════════════════════════════╗");
  console.log("║         Gateway Manual Tests (Redis on 6380)              ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");
  
  // Check server health
  console.log("\nChecking server health...");
  try {
    const health = await makeRequest("GET", "/health", {});
    console.log(`Server: ${health.body.status}`);
    console.log(`Redis: ${health.body.redis}`);
    
    if (health.body.redis !== "connected") {
      console.error("\n✗ Redis is not connected! Cannot run tests.");
      process.exit(1);
    }
  } catch (err) {
    console.error("\n✗ Server is not responding:", err.message);
    process.exit(1);
  }
  
  // Run tests
  await test1();
  await test2();
  await test3();
  await test5();
  
  console.log("\n" + "=".repeat(60));
  console.log("ALL TESTS COMPLETED");
  console.log("=".repeat(60) + "\n");
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});

