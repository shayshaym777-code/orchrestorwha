const express = require("express");
const path = require("path");
const dotenv = require("dotenv");

const messagesRouter = require("./routes/messages");
const orchestratorRouter = require("./routes/orchestrator");
const dashboardApiRouter = require("./routes/dashboardApi");
const warmingApiRouter = require("./routes/warmingApi");
const dispatcherRouter = require("./routes/dispatcherRoutes");
const antiBanApiRouter = require("./routes/antiBanApi");
const backupRouter = require("./routes/backupRoutes");
const aiRouter = require("./routes/aiRoutes");
const { startOrchestratorRunner } = require("./orchestrator/runner");
const cronService = require("./services/cronService");
const { startScheduler } = require("./services/warmingScheduler");
const { alertSystemStartup } = require("./services/telegramAlertService");

dotenv.config();

const app = express();

// Serve static files (dashboard)
app.use(express.static(path.join(__dirname, "public")));

// Note: multipart/form-data requests are handled per-route via multer.
app.use(express.json({ limit: "1mb" }));

app.get("/health", async (_req, res) => {
  return res.status(200).json({ status: "ok" });
});

// Dashboard UI routes
app.get("/dashboard", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/monitor", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "monitor.html"));
});

app.get("/live-log", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "live-log.html"));
});

app.get("/warming", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "warming.html"));
});

app.get("/anti-ban", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "anti-ban.html"));
});

// Learning dashboard (AI insights)
app.get("/learning", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "learning.html"));
});

// Main scanning page (simple 3-QR view)
app.get("/scan", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "scan.html"));
});

app.use("/api/messages", messagesRouter);
app.use("/api/v1/dashboard", dashboardApiRouter);
app.use("/api/v1/backups", backupRouter);
app.use("/api/v1/alerts", backupRouter);  // Alert routes are in the same file
app.use("/api/v1/ai", aiRouter);  // Gemini AI routes
app.use("/api/warming", warmingApiRouter);
app.use("/api/dispatcher", dispatcherRouter);
app.use("/api/anti-ban", antiBanApiRouter);
app.use("/", orchestratorRouter);

// Fallback
app.use((_req, res) => {
  return res.status(404).json({ status: "error", reason: "Not found" });
});

// Error handler
app.use((err, _req, res, _next) => {
  const statusCode = typeof err?.statusCode === "number" ? err.statusCode : 500;
  const reason =
    typeof err?.message === "string" && err.message.length > 0
      ? err.message
      : "Internal error";

  return res.status(statusCode).json({ status: "error", reason });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
  
  // 🔔 Send Telegram startup alert (if configured)
  alertSystemStartup().catch(() => {});
});

// Background orchestrator loop (non-blocking)
startOrchestratorRunner();

// Start CRON jobs (daily reset, warming pulses)
cronService.startCronJobs();

// Start Smart Warming Scheduler
startScheduler();


