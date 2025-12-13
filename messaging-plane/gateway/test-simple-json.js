// Simple JSON test
const http = require("http");

const payload = JSON.stringify({
  idempotencyKey: "test-simple-001",
  message: "Hello test",
  contacts: [
    { name: "David", phone: "972501234567" }
  ]
});

const options = {
  hostname: "localhost",
  port: 4000,
  path: "/v1/jobs",
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-API-KEY": "change-me",
    "Content-Length": Buffer.byteLength(payload)
  }
};

console.log("Sending request...");
console.log("Payload:", payload);

const req = http.request(options, (res) => {
  let data = "";
  res.on("data", chunk => data += chunk);
  res.on("end", () => {
    console.log("\nStatus:", res.statusCode);
    console.log("Response:", data);
    process.exit(res.statusCode === 200 ? 0 : 1);
  });
});

req.on("error", (err) => {
  console.error("Error:", err.message);
  process.exit(1);
});

req.write(payload);
req.end();

// Timeout
setTimeout(() => {
  console.error("Timeout");
  process.exit(1);
}, 5000);

