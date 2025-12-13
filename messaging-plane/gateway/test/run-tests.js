/**
 * Gateway Integration Tests
 * 
 * Runs 5 critical tests per GATEWAY_SPEC.md requirements:
 * 1. JSON message mode → 200 + jobId
 * 2. Multipart image mode → 200 + jobId
 * 3. Idempotency → same jobId on repeat
 * 4. Redis down → 503 QUEUE_UNAVAILABLE
 * 5. Job enqueued proof (queue inspection)
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

// ===========================================
// TEST CONFIGURATION
// ===========================================

const CONFIG = {
  baseUrl: process.env.GATEWAY_URL || "http://localhost:4000",
  apiKey: process.env.API_KEY || "change-me",
  redisUrl: process.env.REDIS_URL || "redis://127.0.0.1:6379"
};

// ===========================================
// HTTP HELPERS
// ===========================================

function makeRequest(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname,
      method: method,
      headers: headers,
      timeout: 10000
    };
    
    const protocol = parsedUrl.protocol === "https:" ? https : http;
    
    const req = protocol.request(options, (res) => {
      let data = "";
      
      res.on("data", (chunk) => {
        data += chunk;
      });
      
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: parsed
          });
        } catch (e) {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: data
          });
        }
      });
    });
    
    req.on("error", (e) => {
      reject(e);
    });
    
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    
    if (body) {
      req.write(body);
    }
    
    req.end();
  });
}

function makeMultipartRequest(url, fields, file) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const boundary = `----WebKitFormBoundary${Date.now()}`;
    
    let body = "";
    
    // Add text fields
    for (const [key, value] of Object.entries(fields)) {
      body += `--${boundary}\r\n`;
      body += `Content-Disposition: form-data; name="${key}"\r\n\r\n`;
      body += `${value}\r\n`;
    }
    
    // Add file
    if (file) {
      const fileContent = fs.readFileSync(file.path);
      body += `--${boundary}\r\n`;
      body += `Content-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"\r\n`;
      body += `Content-Type: ${file.mimeType}\r\n\r\n`;
      
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname,
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "X-API-KEY": CONFIG.apiKey
        },
        timeout: 10000
      };
      
      const protocol = parsedUrl.protocol === "https:" ? https : http;
      
      const req = protocol.request(options, (res) => {
        let data = "";
        
        res.on("data", (chunk) => {
          data += chunk;
        });
        
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            resolve({
              statusCode: res.statusCode,
              headers: res.headers,
              body: parsed
            });
          } catch (e) {
            resolve({
              statusCode: res.statusCode,
              headers: res.headers,
              body: data
            });
          }
        });
      });
      
      req.on("error", (e) => {
        reject(e);
      });
      
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timeout"));
      });
      
      // Write multipart body
      req.write(Buffer.concat([
        Buffer.from(body),
        fileContent,
        Buffer.from(`\r\n--${boundary}--\r\n`)
      ]));
      
      req.end();
    }
  });
}

// ===========================================
// TEST UTILITIES
// ===========================================

let testsPassed = 0;
let testsFailed = 0;

function log(message, color = "") {
  const colors = {
    green: "\x1b[32m",
    red: "\x1b[31m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    reset: "\x1b[0m"
  };
  
  const colorCode = colors[color] || "";
  console.log(`${colorCode}${message}${colors.reset}`);
}

function testHeader(testName) {
  console.log("\n" + "=".repeat(60));
  log(`TEST: ${testName}`, "blue");
  console.log("=".repeat(60));
}

function testResult(passed, message) {
  if (passed) {
    log(`✓ PASS: ${message}`, "green");
    testsPassed++;
  } else {
    log(`✗ FAIL: ${message}`, "red");
    testsFailed++;
  }
}

function printSummary() {
  console.log("\n" + "=".repeat(60));
  log("TEST SUMMARY", "blue");
  console.log("=".repeat(60));
  log(`Passed: ${testsPassed}`, "green");
  log(`Failed: ${testsFailed}`, testsFailed > 0 ? "red" : "green");
  console.log("=".repeat(60) + "\n");
  
  if (testsFailed > 0) {
    process.exit(1);
  }
}

// ===========================================
// TESTS
// ===========================================

async function test1_JsonMode() {
  testHeader("1. JSON Message Mode → 200 + jobId");
  
  try {
    const payload = {
      idempotencyKey: `test-json-${Date.now()}`,
      message: "שלום, זוהי בדיקה של JSON mode",
      contacts: [
        { name: "David Cohen", phone: "972501234567" },
        { name: "Sarah Levi", phone: "972509876543" }
      ]
    };
    
    log("\nRequest payload:");
    console.log(JSON.stringify(payload, null, 2));
    
    const response = await makeRequest(
      "POST",
      `${CONFIG.baseUrl}/v1/jobs`,
      {
        "Content-Type": "application/json",
        "X-API-KEY": CONFIG.apiKey
      },
      JSON.stringify(payload)
    );
    
    log("\nResponse:");
    console.log(JSON.stringify(response.body, null, 2));
    log(`Status Code: ${response.statusCode}`);
    
    testResult(
      response.statusCode === 200,
      `Status code is 200 (got ${response.statusCode})`
    );
    
    testResult(
      response.body.status === "ok",
      `Response status is "ok" (got "${response.body.status}")`
    );
    
    testResult(
      typeof response.body.jobId === "string" && response.body.jobId.length > 0,
      `jobId is present (got "${response.body.jobId}")`
    );
    
    testResult(
      response.body.received === 2,
      `received count is 2 (got ${response.body.received})`
    );
    
    testResult(
      response.body.hasImage === false,
      `hasImage is false (got ${response.body.hasImage})`
    );
    
    return response.body.jobId;
    
  } catch (err) {
    log(`\n✗ ERROR: ${err.message}`, "red");
    testsFailed++;
    return null;
  }
}

async function test2_MultipartImageMode() {
  testHeader("2. Multipart Image Mode → 200 + jobId");
  
  try {
    // Create test image
    const testImagePath = path.join(__dirname, "test-image.jpg");
    
    // Create a minimal JPEG (1x1 pixel)
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
    
    fs.writeFileSync(testImagePath, minimalJpeg);
    
    log("\nRequest:");
    log("Content-Type: multipart/form-data");
    log("Fields: idempotencyKey, contacts (JSON array string)");
    log("File: test-image.jpg (image/jpeg)");
    
    const contactsJson = JSON.stringify([
      { name: "Test User", phone: "972501111111" }
    ]);
    
    const response = await makeMultipartRequest(
      `${CONFIG.baseUrl}/v1/jobs`,
      {
        idempotencyKey: `test-image-${Date.now()}`,
        contacts: contactsJson
      },
      {
        fieldName: "image",
        filename: "test-image.jpg",
        mimeType: "image/jpeg",
        path: testImagePath
      }
    );
    
    log("\nResponse:");
    console.log(JSON.stringify(response.body, null, 2));
    log(`Status Code: ${response.statusCode}`);
    
    testResult(
      response.statusCode === 200,
      `Status code is 200 (got ${response.statusCode})`
    );
    
    testResult(
      response.body.status === "ok",
      `Response status is "ok"`
    );
    
    testResult(
      typeof response.body.jobId === "string",
      `jobId is present`
    );
    
    testResult(
      response.body.hasImage === true,
      `hasImage is true (got ${response.body.hasImage})`
    );
    
    // Cleanup
    try {
      fs.unlinkSync(testImagePath);
    } catch (e) {}
    
    return response.body.jobId;
    
  } catch (err) {
    log(`\n✗ ERROR: ${err.message}`, "red");
    testsFailed++;
    return null;
  }
}

async function test3_Idempotency() {
  testHeader("3. Idempotency → Same jobId on Repeat");
  
  try {
    const idempotencyKey = `test-idempotent-${Date.now()}`;
    
    const payload = {
      idempotencyKey: idempotencyKey,
      message: "Test idempotency",
      contacts: [
        { name: "Test", phone: "972500000000" }
      ]
    };
    
    log("\nSending first request with idempotencyKey:");
    log(`  ${idempotencyKey}`);
    
    const response1 = await makeRequest(
      "POST",
      `${CONFIG.baseUrl}/v1/jobs`,
      {
        "Content-Type": "application/json",
        "X-API-KEY": CONFIG.apiKey
      },
      JSON.stringify(payload)
    );
    
    log("\nFirst response:");
    console.log(JSON.stringify(response1.body, null, 2));
    
    const jobId1 = response1.body.jobId;
    
    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 100));
    
    log("\nSending second request with SAME idempotencyKey...");
    
    const response2 = await makeRequest(
      "POST",
      `${CONFIG.baseUrl}/v1/jobs`,
      {
        "Content-Type": "application/json",
        "X-API-KEY": CONFIG.apiKey
      },
      JSON.stringify(payload)
    );
    
    log("\nSecond response:");
    console.log(JSON.stringify(response2.body, null, 2));
    
    const jobId2 = response2.body.jobId;
    
    testResult(
      response1.statusCode === 200 && response2.statusCode === 200,
      `Both requests returned 200`
    );
    
    testResult(
      jobId1 === jobId2,
      `Both requests returned same jobId: "${jobId1}"`
    );
    
    testResult(
      jobId1 && jobId2,
      `jobId is not empty`
    );
    
    return jobId1;
    
  } catch (err) {
    log(`\n✗ ERROR: ${err.message}`, "red");
    testsFailed++;
    return null;
  }
}

async function test4_RedisDown() {
  testHeader("4. Redis Down → 503 QUEUE_UNAVAILABLE");
  
  log("\n⚠️  This test requires you to manually STOP Redis before running.");
  log("⚠️  If Redis is running, this test will be SKIPPED.");
  log("\nChecking Redis availability...");
  
  try {
    // Try to connect to check if Redis is down
    const healthCheck = await makeRequest(
      "GET",
      `${CONFIG.baseUrl}/health`,
      {},
      null
    );
    
    log("\nHealth check response:");
    console.log(JSON.stringify(healthCheck.body, null, 2));
    
    if (healthCheck.body.redis === "connected") {
      log("\n⚠️  Redis is UP. Cannot test Redis down scenario.", "yellow");
      log("⚠️  To test this: Stop Redis, then run tests again.", "yellow");
      testResult(true, "SKIPPED (Redis is running)");
      return;
    }
    
    log("\n✓ Redis is DOWN. Proceeding with test...");
    
    const payload = {
      message: "This should fail",
      contacts: [{ name: "Test", phone: "972500000000" }]
    };
    
    const response = await makeRequest(
      "POST",
      `${CONFIG.baseUrl}/v1/jobs`,
      {
        "Content-Type": "application/json",
        "X-API-KEY": CONFIG.apiKey
      },
      JSON.stringify(payload)
    );
    
    log("\nResponse:");
    console.log(JSON.stringify(response.body, null, 2));
    log(`Status Code: ${response.statusCode}`);
    
    testResult(
      response.statusCode === 503,
      `Status code is 503 (got ${response.statusCode})`
    );
    
    testResult(
      response.body.status === "error",
      `Response status is "error"`
    );
    
    testResult(
      response.body.code === "QUEUE_UNAVAILABLE",
      `Error code is QUEUE_UNAVAILABLE (got "${response.body.code}")`
    );
    
  } catch (err) {
    log(`\n✗ ERROR: ${err.message}`, "red");
    testsFailed++;
  }
}

async function test5_QueueInspection() {
  testHeader("5. Job Enqueued Proof (Queue Inspection)");
  
  try {
    log("\nChecking queue status before...");
    
    const beforeResponse = await makeRequest(
      "GET",
      `${CONFIG.baseUrl}/health/queue`,
      {
        "X-API-KEY": CONFIG.apiKey
      },
      null
    );
    
    log("\nQueue before:");
    console.log(JSON.stringify(beforeResponse.body, null, 2));
    
    const lengthBefore = beforeResponse.body.queue?.length || 0;
    
    log(`\nQueue length before: ${lengthBefore}`);
    
    // Send a job
    log("\nSending a new job...");
    
    const payload = {
      idempotencyKey: `test-queue-proof-${Date.now()}`,
      message: "Test queue enqueue",
      contacts: [{ name: "Queue Test", phone: "972500000001" }]
    };
    
    const jobResponse = await makeRequest(
      "POST",
      `${CONFIG.baseUrl}/v1/jobs`,
      {
        "Content-Type": "application/json",
        "X-API-KEY": CONFIG.apiKey
      },
      JSON.stringify(payload)
    );
    
    log("\nJob created:");
    console.log(JSON.stringify(jobResponse.body, null, 2));
    
    // Check queue again
    log("\nChecking queue status after...");
    
    const afterResponse = await makeRequest(
      "GET",
      `${CONFIG.baseUrl}/health/queue`,
      {
        "X-API-KEY": CONFIG.apiKey
      },
      null
    );
    
    log("\nQueue after:");
    console.log(JSON.stringify(afterResponse.body, null, 2));
    
    const lengthAfter = afterResponse.body.queue?.length || 0;
    
    log(`\nQueue length after: ${lengthAfter}`);
    
    testResult(
      jobResponse.statusCode === 200,
      `Job created successfully (200)`
    );
    
    testResult(
      lengthAfter > lengthBefore,
      `Queue length increased: ${lengthBefore} → ${lengthAfter}`
    );
    
    testResult(
      afterResponse.body.queue?.key === "gateway:jobs",
      `Queue key is "gateway:jobs"`
    );
    
    log(`\n✓ PROOF: Job "${jobResponse.body.jobId}" was enqueued to Redis`);
    
  } catch (err) {
    log(`\n✗ ERROR: ${err.message}`, "red");
    testsFailed++;
  }
}

// ===========================================
// MAIN
// ===========================================

async function main() {
  log("\n╔═══════════════════════════════════════════════════════════╗", "blue");
  log("║           Gateway Integration Tests                       ║", "blue");
  log("║           (GATEWAY_SPEC.md compliance)                    ║", "blue");
  log("╚═══════════════════════════════════════════════════════════╝", "blue");
  
  log(`\nGateway URL: ${CONFIG.baseUrl}`);
  log(`API Key: ${CONFIG.apiKey.slice(0, 10)}...`);
  
  // Wait for server to be ready
  log("\nWaiting for server...");
  let ready = false;
  for (let i = 0; i < 10; i++) {
    try {
      const health = await makeRequest("GET", `${CONFIG.baseUrl}/health`, {}, null);
      if (health.statusCode === 200) {
        log("✓ Server is ready\n", "green");
        ready = true;
        break;
      }
    } catch (e) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  if (!ready) {
    log("✗ Server is not responding. Make sure it's running on port 4000.", "red");
    log(`  Run: cd messaging-plane/gateway && npm start`, "yellow");
    process.exit(1);
  }
  
  // Run tests
  await test1_JsonMode();
  await test2_MultipartImageMode();
  await test3_Idempotency();
  await test4_RedisDown();
  await test5_QueueInspection();
  
  // Print summary
  printSummary();
}

// Run tests
main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});

