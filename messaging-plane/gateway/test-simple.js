// Simple server test
require("dotenv").config();
const { app, start } = require("./src/server");

console.log("Starting server...");
const server = start();

setTimeout(() => {
  console.log("Server should be running. Testing...");
  const http = require("http");
  
  http.get("http://localhost:4000/health", (res) => {
    let data = "";
    res.on("data", chunk => data += chunk);
    res.on("end", () => {
      console.log("Response:", data);
      console.log("Status:", res.statusCode);
      server.close();
      process.exit(res.statusCode === 200 ? 0 : 1);
    });
  }).on("error", (err) => {
    console.error("Error:", err.message);
    server.close();
    process.exit(1);
  });
}, 3000);

