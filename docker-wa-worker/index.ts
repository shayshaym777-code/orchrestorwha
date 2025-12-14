import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  jidDecode,
  fetchLatestBaileysVersion,
  proto,
  WASocket
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import * as fs from "fs-extra";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import axios from "axios";
import * as http from "http";
import * as crypto from "crypto";

// === Docker ENV config ===
const SESSION_ID = process.env.SESSION_ID || "default_session";
const PROXY_URL = process.env.PROXY_URL || "";
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";  // API key for webhook auth

// Orchestrator outbox pull (Dispatcher -> Orchestrator -> Worker queue)
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || "";
const ENABLE_OUTBOX_PULL = process.env.ENABLE_OUTBOX_PULL === "true";
const OUTBOX_CLAIM_TIMEOUT = Math.min(Math.max(Number(process.env.OUTBOX_CLAIM_TIMEOUT || 20), 1), 60);

// Optional: internal media download (for image mode)
const MEDIA_BASE_URL = process.env.MEDIA_BASE_URL || "";
const MEDIA_INTERNAL_KEY = process.env.MEDIA_INTERNAL_KEY || "";

// Testing: simulate worker without WhatsApp connection
const NO_WA_SIMULATE = process.env.NO_WA_SIMULATE === "true";

// === DEBUG/PRODUCTION MODE ===
// In production: ENABLE_API_SERVER=false (default), no ports exposed
// In debug: ENABLE_API_SERVER=true to enable dashboard on API_PORT
const ENABLE_API_SERVER = process.env.ENABLE_API_SERVER === "true";
const API_PORT = Number(process.env.API_PORT || 3001);

// Browser fingerprint - can be overridden by ENV or auto-generated
const BROWSER_OS = process.env.BROWSER_OS || "";
const BROWSER_NAME = process.env.BROWSER_NAME || "";
const BROWSER_VERSION = process.env.BROWSER_VERSION || "";

// Anti-ban settings (can be disabled for Orchestrator control)
// Set ENABLE_SEND_DELAY=false to let Orchestrator handle delays
const ENABLE_SEND_DELAY = process.env.ENABLE_SEND_DELAY !== "false";
const MESSAGE_DELAY_MIN = Number(process.env.MESSAGE_DELAY_MIN || 1000);  // 1 second min
const MESSAGE_DELAY_MAX = Number(process.env.MESSAGE_DELAY_MAX || 3000);  // 3 seconds max
const RECONNECT_DELAY_MS = Number(process.env.RECONNECT_DELAY_MS || 3000);
const MAX_RECONNECT_ATTEMPTS = Number(process.env.MAX_RECONNECT_ATTEMPTS || 5);
const RECONNECT_BACKOFF_MULTIPLIER = Number(process.env.RECONNECT_BACKOFF_MULTIPLIER || 1.5);

// === KEEP-ALIVE ENGINE (Anti-Ban) ===
const ENABLE_KEEP_ALIVE = process.env.ENABLE_KEEP_ALIVE !== "false";
const PRESENCE_INTERVAL_MS = Number(process.env.PRESENCE_INTERVAL_MS || 15000);  // 15 seconds
const HIDDEN_MSG_INTERVAL_MS = Number(process.env.HIDDEN_MSG_INTERVAL_MS || 600000);  // 10 minutes

// Fixed path inside container (mapped to external volume)
const AUTH_DIR = `/app/sessions/${SESSION_ID}`;
const LOCK_FILE = `${AUTH_DIR}/.lock`;

// ============================================
// FINGERPRINT GENERATOR (Anti-Ban)
// ============================================
interface BrowserFingerprint {
  os: string;
  name: string;
  version: string;
}

const BROWSER_PROFILES: BrowserFingerprint[] = [
  { os: "Windows", name: "Chrome", version: "120.0.6099.130" },
  { os: "Windows", name: "Chrome", version: "119.0.6045.199" },
  { os: "Windows", name: "Chrome", version: "121.0.6167.85" },
  { os: "Windows", name: "Edge", version: "120.0.2210.91" },
  { os: "Windows", name: "Firefox", version: "121.0" },
  { os: "macOS", name: "Chrome", version: "120.0.6099.130" },
  { os: "macOS", name: "Safari", version: "17.2.1" },
  { os: "macOS", name: "Chrome", version: "119.0.6045.199" },
  { os: "Linux", name: "Chrome", version: "120.0.6099.130" },
  { os: "Linux", name: "Firefox", version: "121.0" },
];

function generateFingerprint(sessionId: string): BrowserFingerprint {
  // If all ENV vars are set, use them
  if (BROWSER_OS && BROWSER_NAME && BROWSER_VERSION) {
    return { os: BROWSER_OS, name: BROWSER_NAME, version: BROWSER_VERSION };
  }
  
  // Generate consistent fingerprint based on session ID (same session = same fingerprint)
  const hash = crypto.createHash('md5').update(sessionId).digest('hex');
  const index = parseInt(hash.slice(0, 8), 16) % BROWSER_PROFILES.length;
  
  const base = BROWSER_PROFILES[index];
  
  // Add slight variation to version based on session
  const versionParts = base.version.split('.');
  const lastPart = parseInt(versionParts[versionParts.length - 1]) || 0;
  const variation = parseInt(hash.slice(8, 10), 16) % 20;
  versionParts[versionParts.length - 1] = String(lastPart + variation);
  
  return {
    os: base.os,
    name: base.name,
    version: versionParts.join('.')
  };
}

// Generate fingerprint for this session
const fingerprint = generateFingerprint(SESSION_ID);
console.log(`🔐 Fingerprint: ${fingerprint.os}/${fingerprint.name}/${fingerprint.version}`);

// ============================================
// DELAY/JITTER UTILITIES (Anti-Ban)
// ============================================
function randomDelay(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sleepWithJitter(baseMs: number, jitterPercent: number = 30): Promise<void> {
  const jitter = baseMs * (jitterPercent / 100);
  const actualDelay = baseMs + randomDelay(-jitter, jitter);
  await sleep(Math.max(100, actualDelay));
}

// ============================================
// SESSION LOCK (Isolation)
// ============================================
function acquireSessionLock(): boolean {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const lockData = fs.readFileSync(LOCK_FILE, 'utf-8');
      const lockInfo = JSON.parse(lockData);
      
      // Check if lock is stale (older than 2 minutes)
      const lockAge = Date.now() - lockInfo.timestamp;
      if (lockAge < 120000) {
        console.error(`❌ Session ${SESSION_ID} is already locked by container ${lockInfo.containerId}`);
        console.error(`   Lock age: ${Math.floor(lockAge / 1000)}s`);
        return false;
      }
      console.warn(`⚠️ Found stale lock, overwriting...`);
    }
    
    // Create lock file
    const containerId = process.env.HOSTNAME || crypto.randomBytes(8).toString('hex');
    fs.writeFileSync(LOCK_FILE, JSON.stringify({
      containerId,
      sessionId: SESSION_ID,
      timestamp: Date.now(),
      pid: process.pid
    }));
    
    return true;
  } catch (error) {
    console.error('Failed to acquire lock:', error);
    return false;
  }
}

function releaseSessionLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch (error) {
    // Ignore errors when releasing lock
  }
}

function refreshLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8'));
      lockData.timestamp = Date.now();
      fs.writeFileSync(LOCK_FILE, JSON.stringify(lockData));
    }
  } catch (error) {
    // Ignore errors
  }
}

// ============================================
// PROXY VERIFICATION (Anti-Ban)
// ============================================
interface ProxyInfo {
  configured: boolean;
  url: string;
  type: 'http' | 'https' | 'socks5' | 'socks5h' | 'none';
  externalIp: string | null;
  verified: boolean;
  error: string | null;
}

function getProxyType(url: string): 'http' | 'https' | 'socks5' | 'socks5h' | 'none' {
  if (!url) return 'none';
  if (url.startsWith('socks5h://')) return 'socks5h';
  if (url.startsWith('socks5://')) return 'socks5';
  if (url.startsWith('https://')) return 'https';
  return 'http';
}

function createProxyAgent(proxyUrl: string): any {
  if (!proxyUrl) return undefined;
  
  const proxyType = getProxyType(proxyUrl);
  
  if (proxyType === 'socks5' || proxyType === 'socks5h') {
    console.log(`🔌 Creating SOCKS5 proxy agent...`);
    return new SocksProxyAgent(proxyUrl);
  } else {
    const cleanProxy = proxyUrl.replace("https://", "http://");
    console.log(`🔌 Creating HTTP proxy agent...`);
    return new HttpsProxyAgent(cleanProxy, { rejectUnauthorized: false });
  }
}

async function verifyProxy(): Promise<ProxyInfo> {
  const proxyType = getProxyType(PROXY_URL);
  
  const info: ProxyInfo = {
    configured: !!PROXY_URL,
    url: PROXY_URL ? PROXY_URL.replace(/:[^:@]+@/, ':***@') : '',
    type: proxyType,
    externalIp: null,
    verified: false,
    error: null
  };
  
  if (!PROXY_URL) {
    return info;
  }
  
  try {
    const agent = createProxyAgent(PROXY_URL);
    
    const response = await axios.get('https://api.ipify.org?format=json', {
      httpsAgent: agent,
      httpAgent: agent,
      timeout: 15000
    });
    
    info.externalIp = response.data.ip;
    info.verified = true;
    
    console.log(`✅ Proxy verified! Type: ${proxyType}, External IP: ${info.externalIp}`);
  } catch (error: any) {
    info.error = error?.message || 'Unknown error';
    console.error(`❌ Proxy verification failed: ${info.error}`);
  }
  
  return info;
}

// ============================================
// SESSION STATE
// ============================================
interface SessionState {
  status: "INITIALIZING" | "WAITING_QR" | "CONNECTING" | "CONNECTED" | "DISCONNECTED" | "LOGGED_OUT" | "LOCKED";
  phoneNumber: string | null;
  jid: string | null;
  startTime: number;
  connectedAt: number | null;
  lastQrAt: number | null;
  qrCount: number;
  messagesSent: number;
  messagesFailed: number;
  messagesQueued: number;
  lastPingAt: number | null;
  reconnectAttempts: number;
  fingerprint: BrowserFingerprint;
  proxy: ProxyInfo | null;
  events: Array<{ time: number; event: string; details?: string }>;
}

const sessionState: SessionState = {
  status: "INITIALIZING",
  phoneNumber: null,
  jid: null,
  startTime: Date.now(),
  connectedAt: null,
  lastQrAt: null,
  qrCount: 0,
  messagesSent: 0,
  messagesFailed: 0,
  messagesQueued: 0,
  lastPingAt: null,
  reconnectAttempts: 0,
  fingerprint,
  proxy: null,
  events: []
};

// ============================================
// MESSAGE QUEUE
// ============================================
interface QueuedMessage {
  id: string;
  to: string;
  text: string;
  mode?: "message" | "image";
  mediaRef?: string;
  jobId?: string;
  taskId?: string;
  outboxRaw?: string; // exact raw string returned from outbox claim (required for ack/nack)
  status: "queued" | "sending" | "sent" | "failed";
  createdAt: number;
  sentAt?: number;
  error?: string;
  attempts: number;
}

const messageQueue: QueuedMessage[] = [];
let isProcessingQueue = false;

// ============================================
// WHATSAPP SOCKET
// ============================================
let sock: WASocket | null = null;

// ============================================
// TELEMETRY / STRUCTURED LOGGING
// ============================================
interface TelemetryEvent {
  timestamp: number;
  sessionId: string;
  eventType: string;
  proxy: string | null;
  browserFingerprint: string;
  data?: any;
}

function logTelemetry(eventType: string, data?: any): void {
  const event: TelemetryEvent = {
    timestamp: Date.now(),
    sessionId: SESSION_ID,
    eventType,
    proxy: sessionState.proxy?.externalIp || (PROXY_URL ? 'unverified' : null),
    browserFingerprint: `${fingerprint.os}/${fingerprint.name}/${fingerprint.version}`,
    data
  };
  
  // Structured JSON log for parsing
  console.log(`[TELEMETRY] ${JSON.stringify(event)}`);
}

// ============================================
// HELPER FUNCTIONS
// ============================================
function addEvent(event: string, details?: string) {
  sessionState.events.push({ time: Date.now(), event, details });
  if (sessionState.events.length > 100) {
    sessionState.events = sessionState.events.slice(-100);
  }
  logTelemetry(event, { details });
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function formatPhoneNumber(phone: string): string {
  if (phone.startsWith("972")) {
    return `+${phone.slice(0, 3)} ${phone.slice(3, 5)}-${phone.slice(5, 8)}-${phone.slice(8)}`;
  }
  return phone;
}

// ============================================
// WEBHOOK CLIENT
// ============================================
const httpClient = axios.create({
  timeout: Number(process.env.WEBHOOK_TIMEOUT_MS || 10000),
  headers: WEBHOOK_SECRET ? {
    'Authorization': `Bearer ${WEBHOOK_SECRET}`,
    'X-Webhook-Secret': WEBHOOK_SECRET
  } : {}
});

const orchestratorClient = axios.create({
  baseURL: ORCHESTRATOR_URL || undefined,
  timeout: Number(process.env.ORCHESTRATOR_TIMEOUT_MS || 30000),
  headers: WEBHOOK_SECRET ? {
    'X-Webhook-Secret': WEBHOOK_SECRET,
    'Authorization': `Bearer ${WEBHOOK_SECRET}`
  } : {}
});

async function outboxAck(raw: string) {
  if (!ORCHESTRATOR_URL || !WEBHOOK_SECRET) return;
  await orchestratorClient.post(`/api/worker/sessions/${SESSION_ID}/outbox/ack`, { raw });
}

async function outboxNack(raw: string) {
  if (!ORCHESTRATOR_URL || !WEBHOOK_SECRET) return;
  await orchestratorClient.post(`/api/worker/sessions/${SESSION_ID}/outbox/nack`, { raw });
}

async function downloadMediaIfNeeded(msg: QueuedMessage): Promise<Buffer | null> {
  if (msg.mode !== "image") return null;
  if (!msg.mediaRef) throw new Error("Missing mediaRef");
  if (!MEDIA_BASE_URL || !MEDIA_INTERNAL_KEY) {
    throw new Error("MEDIA_BASE_URL or MEDIA_INTERNAL_KEY not configured");
  }

  const res = await axios.get(`${MEDIA_BASE_URL.replace(/\/$/, "")}/internal/media/${encodeURIComponent(msg.mediaRef)}`, {
    responseType: "arraybuffer",
    timeout: 30000,
    headers: { "X-INTERNAL-KEY": MEDIA_INTERNAL_KEY }
  });
  return Buffer.from(res.data);
}

async function startOutboxPullLoop() {
  if (!ENABLE_OUTBOX_PULL) return;
  if (!ORCHESTRATOR_URL || !WEBHOOK_SECRET) {
    console.warn("⚠️ ENABLE_OUTBOX_PULL=true אבל חסרים ORCHESTRATOR_URL/WEBHOOK_SECRET");
    return;
  }

  addEvent("OUTBOX_PULL_START", `timeout=${OUTBOX_CLAIM_TIMEOUT}s`);
  console.log(`📥 Outbox pull enabled: ${ORCHESTRATOR_URL} (timeout=${OUTBOX_CLAIM_TIMEOUT}s)`);

  // Loop forever; Orchestrator side uses long-poll BRPOPLPUSH.
  // We enqueue tasks locally; sending is handled by processMessageQueue().
  while (true) {
    try {
      const resp = await orchestratorClient.post(
        `/api/worker/sessions/${SESSION_ID}/outbox/claim?timeout=${OUTBOX_CLAIM_TIMEOUT}`,
        {}
      );

      const task = resp?.data?.task;
      const raw = resp?.data?.raw;

      if (!task) {
        continue;
      }

      const to = String(task.to || "").replace(/[^0-9]/g, "");
      const mode = task.mode === "image" ? "image" : "message";

      const msgId = task.messageId || `outbox_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

      const queuedMsg: QueuedMessage = {
        id: msgId,
        to,
        text: String(task.text || ""),
        mode,
        mediaRef: task.mediaRef,
        jobId: task.jobId,
        taskId: task.taskId,
        outboxRaw: typeof raw === "string" ? raw : undefined,
        status: "queued",
        createdAt: Date.now(),
        attempts: 0
      };

      messageQueue.push(queuedMsg);
      sessionState.messagesQueued++;

      addEvent("OUTBOX_TASK_CLAIMED", `mode=${mode} to=${to}`);

      // In simulation mode we don't connect to WhatsApp; just ack immediately.
      if (NO_WA_SIMULATE) {
        try {
          if (queuedMsg.outboxRaw) await outboxAck(queuedMsg.outboxRaw);
          queuedMsg.status = "sent";
          queuedMsg.sentAt = Date.now();
          sessionState.messagesSent++;
          sessionState.messagesQueued--;
          await sendWebhook("MESSAGE_SENT", { to, jobId: queuedMsg.jobId, taskId: queuedMsg.taskId, simulated: true });
        } catch (e: any) {
          queuedMsg.status = "failed";
          queuedMsg.error = e?.message || "SIMULATED_SEND_FAILED";
          sessionState.messagesFailed++;
          sessionState.messagesQueued--;
          if (queuedMsg.outboxRaw) await outboxNack(queuedMsg.outboxRaw);
        }
        continue;
      }

      processMessageQueue();
    } catch (e: any) {
      const detail = e?.response
        ? `HTTP ${e.response.status} ${JSON.stringify(e.response.data)}`
        : `${e?.code || ""} ${e?.message || e}`;
      console.error("❌ Outbox pull error:", detail);
      addEvent("OUTBOX_PULL_ERROR", detail);
      // small backoff to avoid hot-loop on network errors
      await sleep(500);
    }
  }
}

async function sendWebhook(type: string, data: any) {
  if (!WEBHOOK_URL) return;
  
  const payload = {
    sessionId: SESSION_ID,
    type,
    timestamp: Date.now(),
    data,
    // Anti-ban telemetry
    meta: {
      fingerprint: `${fingerprint.os}/${fingerprint.name}/${fingerprint.version}`,
      proxy: sessionState.proxy?.externalIp || null,
      proxyUrl: PROXY_URL || null  // ✅ Send full PROXY_URL so orchestrator can use it
    }
  };
  
  try {
    await httpClient.post(WEBHOOK_URL, payload);
    logTelemetry(`WEBHOOK_${type}`, { success: true });
  } catch (e: any) {
    const detail = e?.response
      ? `HTTP ${e.response.status} ${JSON.stringify(e.response.data)}`
      : `${e?.code || ""} ${e?.message || e}`;
    console.error("❌ Webhook Error:", detail);
    logTelemetry(`WEBHOOK_${type}_FAILED`, { error: detail });
  }
}

// ============================================
// MESSAGE QUEUE PROCESSOR
// ============================================
async function processMessageQueue() {
  if (isProcessingQueue || !sock || sessionState.status !== "CONNECTED") {
    return;
  }
  
  isProcessingQueue = true;
  
  while (messageQueue.length > 0) {
    const msg = messageQueue.find(m => m.status === "queued");
    if (!msg) break;
    
    msg.status = "sending";
    msg.attempts++;
    
    try {
      const jid = msg.to.includes("@") ? msg.to : `${msg.to}@s.whatsapp.net`;
      
      // Anti-ban: Add delay with jitter before sending (can be disabled)
      let delay = 0;
      if (ENABLE_SEND_DELAY) {
        delay = randomDelay(MESSAGE_DELAY_MIN, MESSAGE_DELAY_MAX);
        console.log(`⏳ Waiting ${delay}ms before sending (anti-ban delay)...`);
        await sleep(delay);
      }
      
      if (msg.mode === "image") {
        const buf = await downloadMediaIfNeeded(msg);
        await sock.sendMessage(jid, { image: buf as any, caption: msg.text || undefined });
      } else {
        await sock.sendMessage(jid, { text: msg.text });
      }
      
      msg.status = "sent";
      msg.sentAt = Date.now();
      sessionState.messagesSent++;
      sessionState.messagesQueued--;
      
      addEvent("MESSAGE_SENT", `To: ${msg.to}, Delay: ${delay}ms`);
      console.log(`✅ Message sent to ${msg.to}`);

      // Ack outbox item if this message came from Orchestrator outbox claim
      if (msg.outboxRaw) {
        try {
          await outboxAck(msg.outboxRaw);
        } catch (e: any) {
          console.warn("⚠️ Outbox ack failed:", e?.message || e);
        }
      }
      
    } catch (error: any) {
      msg.status = "failed";
      msg.error = error?.message || "Unknown error";
      sessionState.messagesFailed++;
      sessionState.messagesQueued--;
      
      addEvent("MESSAGE_FAILED", `To: ${msg.to} - ${msg.error}`);
      console.error(`❌ Failed to send message to ${msg.to}:`, msg.error);

      // Nack (requeue) outbox item on failure
      if (msg.outboxRaw) {
        try {
          await outboxNack(msg.outboxRaw);
        } catch (e: any) {
          console.warn("⚠️ Outbox nack failed:", e?.message || e);
        }
      }
    }
  }
  
  isProcessingQueue = false;
}

// ============================================
// HTTP API SERVER
// ============================================
function startApiServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${API_PORT}`);
    
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    
    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }
    
    // === Dashboard ===
    if (url.pathname === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(generateDashboardHTML());
      return;
    }
    
    // === Status API ===
    if (url.pathname === "/status" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        sessionId: SESSION_ID,
        ...sessionState,
        uptime: Date.now() - sessionState.startTime,
        connectionDuration: sessionState.connectedAt ? Date.now() - sessionState.connectedAt : null,
        queueLength: messageQueue.filter(m => m.status === "queued").length,
        config: {
          messageDelayMin: MESSAGE_DELAY_MIN,
          messageDelayMax: MESSAGE_DELAY_MAX,
          maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS
        }
      }, null, 2));
      return;
    }
    
    // === Proxy Verify API ===
    if (url.pathname === "/proxy/verify" && req.method === "GET") {
      const proxyInfo = await verifyProxy();
      sessionState.proxy = proxyInfo;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(proxyInfo, null, 2));
      return;
    }
    
    // === Send Message API ===
    if (url.pathname === "/send" && req.method === "POST") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", async () => {
        try {
          const { to, message, text } = JSON.parse(body);
          const phoneNumber = to?.replace(/[^0-9]/g, "");
          const messageText = message || text;
          
          if (!phoneNumber || !messageText) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing 'to' or 'message' field" }));
            return;
          }
          
          const msgId = `msg_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
          
          const queuedMsg: QueuedMessage = {
            id: msgId,
            to: phoneNumber,
            text: messageText,
            status: "queued",
            createdAt: Date.now(),
            attempts: 0
          };
          
          messageQueue.push(queuedMsg);
          sessionState.messagesQueued++;
          
          addEvent("MESSAGE_QUEUED", `To: ${phoneNumber}`);
          
          processMessageQueue();
          
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            success: true,
            messageId: msgId,
            status: sessionState.status === "CONNECTED" ? "queued" : "queued_waiting_connection",
            queuePosition: messageQueue.filter(m => m.status === "queued").length,
            estimatedDelay: `${MESSAGE_DELAY_MIN}-${MESSAGE_DELAY_MAX}ms`
          }));
          
        } catch (e: any) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON body" }));
        }
      });
      return;
    }
    
    // === Queue Status API ===
    if (url.pathname === "/queue" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        queue: messageQueue.slice(-20),
        stats: {
          queued: messageQueue.filter(m => m.status === "queued").length,
          sending: messageQueue.filter(m => m.status === "sending").length,
          sent: messageQueue.filter(m => m.status === "sent").length,
          failed: messageQueue.filter(m => m.status === "failed").length
        }
      }, null, 2));
      return;
    }
    
    // === Events/Telemetry API ===
    if (url.pathname === "/events" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(sessionState.events, null, 2));
      return;
    }
    
    // === Fingerprint API ===
    if (url.pathname === "/fingerprint" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        sessionId: SESSION_ID,
        fingerprint: sessionState.fingerprint,
        fingerprintString: `${fingerprint.os}/${fingerprint.name}/${fingerprint.version}`,
        source: (BROWSER_OS && BROWSER_NAME && BROWSER_VERSION) ? "ENV" : "GENERATED"
      }, null, 2));
      return;
    }
    
    // 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });
  
  server.listen(API_PORT, "0.0.0.0", () => {
    console.log(`📡 API Server running on http://0.0.0.0:${API_PORT}`);
    console.log(`   Dashboard: http://localhost:${API_PORT}/`);
    console.log(`   Status: http://localhost:${API_PORT}/status`);
    console.log(`   Fingerprint: http://localhost:${API_PORT}/fingerprint`);
    console.log(`   Proxy Verify: http://localhost:${API_PORT}/proxy/verify`);
  });
}

// ============================================
// DASHBOARD HTML
// ============================================
function generateDashboardHTML(): string {
  const uptime = formatDuration(Date.now() - sessionState.startTime);
  const connDuration = sessionState.connectedAt 
    ? formatDuration(Date.now() - sessionState.connectedAt) 
    : "—";
  
  const statusColors: Record<string, string> = {
    INITIALIZING: "#f39c12",
    WAITING_QR: "#3498db",
    CONNECTING: "#9b59b6",
    CONNECTED: "#27ae60",
    DISCONNECTED: "#e74c3c",
    LOGGED_OUT: "#c0392b",
    LOCKED: "#7f8c8d"
  };
  
  const statusColor = statusColors[sessionState.status] || "#95a5a6";
  
  const eventsHtml = sessionState.events
    .slice(-15)
    .reverse()
    .map(e => {
      const time = new Date(e.time).toLocaleTimeString("he-IL");
      return `<div class="event"><span class="time">${time}</span> <span class="name">${e.event}</span> ${e.details ? `<span class="details">${e.details}</span>` : ""}</div>`;
    })
    .join("");
  
  const queueHtml = messageQueue
    .slice(-10)
    .reverse()
    .map(m => {
      const statusEmoji = { queued: "⏳", sending: "📤", sent: "✅", failed: "❌" }[m.status];
      return `<div class="queue-item ${m.status}"><span>${statusEmoji}</span> <span>${m.to}</span> <span class="msg-text">${m.text.slice(0, 30)}${m.text.length > 30 ? "..." : ""}</span></div>`;
    })
    .join("") || "<div class='empty'>No messages in queue</div>";

  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="5">
  <title>WhatsApp Worker - ${SESSION_ID}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #eee;
      min-height: 100vh;
      padding: 20px;
    }
    .container { max-width: 1000px; margin: 0 auto; }
    h1 { text-align: center; margin-bottom: 30px; color: #25d366; font-size: 28px; }
    .status-badge {
      display: inline-block;
      padding: 8px 20px;
      border-radius: 20px;
      font-weight: bold;
      font-size: 14px;
      background: ${statusColor};
      margin-bottom: 20px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 20px;
      margin-bottom: 20px;
    }
    .card {
      background: rgba(255,255,255,0.05);
      border-radius: 16px;
      padding: 20px;
      border: 1px solid rgba(255,255,255,0.1);
    }
    .card h2 {
      font-size: 14px;
      color: #888;
      margin-bottom: 15px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .stat {
      display: flex;
      justify-content: space-between;
      padding: 10px 0;
      border-bottom: 1px solid rgba(255,255,255,0.05);
    }
    .stat:last-child { border-bottom: none; }
    .stat-label { color: #aaa; }
    .stat-value { font-weight: bold; color: #fff; }
    .stat-value.highlight { color: #25d366; font-size: 18px; }
    .stat-value.warning { color: #f39c12; }
    .stat-value.error { color: #e74c3c; }
    .event {
      padding: 8px 0;
      border-bottom: 1px solid rgba(255,255,255,0.05);
      font-size: 13px;
    }
    .event .time { color: #666; margin-left: 10px; }
    .event .name { color: #25d366; font-weight: 500; }
    .event .details { color: #888; font-size: 12px; display: block; margin-top: 4px; }
    .queue-item {
      padding: 10px;
      background: rgba(255,255,255,0.03);
      border-radius: 8px;
      margin-bottom: 8px;
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .queue-item.sent { opacity: 0.5; }
    .queue-item.failed { background: rgba(231, 76, 60, 0.2); }
    .msg-text { color: #888; font-size: 12px; flex: 1; text-align: left; }
    .empty { color: #666; text-align: center; padding: 20px; }
    .fingerprint-box {
      background: rgba(37, 211, 102, 0.1);
      border: 1px solid rgba(37, 211, 102, 0.3);
      border-radius: 8px;
      padding: 10px;
      font-family: monospace;
      font-size: 12px;
      color: #25d366;
      direction: ltr;
      text-align: left;
    }
    .proxy-box {
      background: ${sessionState.proxy?.verified ? 'rgba(37, 211, 102, 0.1)' : 'rgba(243, 156, 18, 0.1)'};
      border: 1px solid ${sessionState.proxy?.verified ? 'rgba(37, 211, 102, 0.3)' : 'rgba(243, 156, 18, 0.3)'};
      border-radius: 8px;
      padding: 10px;
      font-family: monospace;
      font-size: 12px;
      direction: ltr;
      text-align: left;
    }
    .send-form {
      background: rgba(37, 211, 102, 0.1);
      border: 1px solid rgba(37, 211, 102, 0.3);
      border-radius: 16px;
      padding: 20px;
      margin-top: 20px;
    }
    .send-form h2 { color: #25d366; margin-bottom: 15px; }
    .form-row { display: flex; gap: 10px; margin-bottom: 10px; }
    .form-row input, .form-row textarea {
      flex: 1;
      padding: 12px;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 8px;
      background: rgba(0,0,0,0.3);
      color: #fff;
      font-size: 14px;
    }
    .form-row button {
      padding: 12px 30px;
      background: #25d366;
      border: none;
      border-radius: 8px;
      color: #fff;
      font-weight: bold;
      cursor: pointer;
    }
    .form-row button:hover { background: #1da851; }
    #result { margin-top: 10px; padding: 10px; border-radius: 8px; display: none; }
    #result.success { background: rgba(39, 174, 96, 0.2); display: block; }
    #result.error { background: rgba(231, 76, 60, 0.2); display: block; }
  </style>
</head>
<body>
  <div class="container">
    <h1>📱 WhatsApp Worker Dashboard</h1>
    
    <div style="text-align: center;">
      <span class="status-badge">${sessionState.status}</span>
    </div>
    
    <div class="grid">
      <div class="card">
        <h2>📋 פרטי סשן</h2>
        <div class="stat">
          <span class="stat-label">Session ID</span>
          <span class="stat-value">${SESSION_ID}</span>
        </div>
        <div class="stat">
          <span class="stat-label">מספר טלפון</span>
          <span class="stat-value highlight">${sessionState.phoneNumber ? formatPhoneNumber(sessionState.phoneNumber) : "—"}</span>
        </div>
        <div class="stat">
          <span class="stat-label">JID</span>
          <span class="stat-value" style="font-size: 11px; direction: ltr;">${sessionState.jid || "—"}</span>
        </div>
      </div>
      
      <div class="card">
        <h2>⏱️ זמנים</h2>
        <div class="stat">
          <span class="stat-label">זמן פעילות</span>
          <span class="stat-value">${uptime}</span>
        </div>
        <div class="stat">
          <span class="stat-label">זמן מחובר</span>
          <span class="stat-value highlight">${connDuration}</span>
        </div>
        <div class="stat">
          <span class="stat-label">QR Codes</span>
          <span class="stat-value">${sessionState.qrCount}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Reconnects</span>
          <span class="stat-value ${sessionState.reconnectAttempts > 3 ? 'warning' : ''}">${sessionState.reconnectAttempts}</span>
        </div>
      </div>
      
      <div class="card">
        <h2>📊 הודעות</h2>
        <div class="stat">
          <span class="stat-label">נשלחו</span>
          <span class="stat-value highlight">${sessionState.messagesSent}</span>
        </div>
        <div class="stat">
          <span class="stat-label">בתור</span>
          <span class="stat-value">${messageQueue.filter(m => m.status === "queued").length}</span>
        </div>
        <div class="stat">
          <span class="stat-label">נכשלו</span>
          <span class="stat-value error">${sessionState.messagesFailed}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Delay</span>
          <span class="stat-value">${MESSAGE_DELAY_MIN}-${MESSAGE_DELAY_MAX}ms</span>
        </div>
      </div>
    </div>
    
    <div class="grid">
      <div class="card">
        <h2>🔐 Anti-Ban: Fingerprint</h2>
        <div class="fingerprint-box">
          OS: ${fingerprint.os}<br>
          Browser: ${fingerprint.name}<br>
          Version: ${fingerprint.version}
        </div>
        <p style="margin-top: 10px; font-size: 12px; color: #888;">
          Source: ${(BROWSER_OS && BROWSER_NAME && BROWSER_VERSION) ? "ENV Variables" : "Auto-generated from Session ID"}
        </p>
      </div>
      
      <div class="card">
        <h2>🌐 Anti-Ban: Proxy</h2>
        <div class="proxy-box">
          ${sessionState.proxy ? `
            Configured: ${sessionState.proxy.configured ? '✅' : '❌'}<br>
            ${sessionState.proxy.configured ? `URL: ${sessionState.proxy.url}<br>` : ''}
            External IP: ${sessionState.proxy.externalIp || 'N/A'}<br>
            Verified: ${sessionState.proxy.verified ? '✅' : '❌'}
            ${sessionState.proxy.error ? `<br>Error: ${sessionState.proxy.error}` : ''}
          ` : `
            Status: Not verified yet<br>
            <a href="/proxy/verify" target="_blank" style="color: #3498db;">Click to verify →</a>
          `}
        </div>
      </div>
    </div>
    
    <div class="grid">
      <div class="card">
        <h2>📜 אירועים אחרונים</h2>
        ${eventsHtml || "<div class='empty'>No events yet</div>"}
      </div>
      
      <div class="card">
        <h2>📬 תור הודעות</h2>
        ${queueHtml}
      </div>
    </div>
    
    ${sessionState.status === "CONNECTED" ? `
    <div class="send-form">
      <h2>✉️ שלח הודעה</h2>
      <form id="sendForm" onsubmit="sendMessage(event)">
        <div class="form-row">
          <input type="text" id="phone" placeholder="מספר טלפון (לדוגמה: 972509456568)" required>
        </div>
        <div class="form-row">
          <textarea id="message" rows="2" placeholder="תוכן ההודעה" required></textarea>
          <button type="submit">שלח</button>
        </div>
      </form>
      <div id="result"></div>
      <p style="margin-top: 10px; font-size: 12px; color: #888;">
        ⏳ השהייה אוטומטית של ${MESSAGE_DELAY_MIN}-${MESSAGE_DELAY_MAX}ms בין הודעות (Anti-Ban)
      </p>
    </div>
    
    <script>
      async function sendMessage(e) {
        e.preventDefault();
        const phone = document.getElementById('phone').value;
        const message = document.getElementById('message').value;
        const result = document.getElementById('result');
        
        try {
          const res = await fetch('/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to: phone, message })
          });
          const data = await res.json();
          
          if (data.success) {
            result.className = 'success';
            result.textContent = '✅ הודעה נוספה לתור! ID: ' + data.messageId;
            document.getElementById('message').value = '';
          } else {
            result.className = 'error';
            result.textContent = '❌ שגיאה: ' + data.error;
          }
        } catch (err) {
          result.className = 'error';
          result.textContent = '❌ שגיאת רשת';
        }
      }
    </script>
    ` : `
    <div class="card" style="text-align: center; padding: 40px;">
      <h2 style="color: #f39c12; margin-bottom: 10px;">⏳ ממתין לחיבור</h2>
      <p style="color: #888;">סרוק QR כדי להתחבר ולשלוח הודעות</p>
    </div>
    `}
    
    <p style="text-align: center; margin-top: 20px; color: #555; font-size: 12px;">
      מתרענן אוטומטית כל 5 שניות | 
      <a href="/status" style="color: #3498db;">API Status</a> | 
      <a href="/fingerprint" style="color: #3498db;">Fingerprint</a> | 
      <a href="/events" style="color: #3498db;">Events</a>
    </p>
  </div>
</body>
</html>`;
}

// ============================================
// KEEP-ALIVE ENGINE (Anti-Ban)
// Based on WhatsApp Session Architecture Document
// ============================================
let keepAliveIntervals: NodeJS.Timeout[] = [];

function startKeepAliveEngine() {
  if (!ENABLE_KEEP_ALIVE) {
    console.log("⚠️ Keep-Alive Engine disabled");
    return;
  }
  
  // Clear any existing intervals
  stopKeepAliveEngine();
  
  console.log("🔄 Starting Keep-Alive Engine...");
  addEvent("KEEP_ALIVE_START", `Presence(${PRESENCE_INTERVAL_MS/1000}s), Hidden(${HIDDEN_MSG_INTERVAL_MS/60000}m)`);
  
  // 1. Presence Update - כל 15 שניות (ברירת מחדל)
  const presenceInterval = setInterval(async () => {
    if (sock && sessionState.status === "CONNECTED") {
      try {
        await sock.sendPresenceUpdate("available");
        logTelemetry("PRESENCE_UPDATE", { type: "available" });
      } catch (e: any) {
        console.warn("⚠️ Presence update failed:", e?.message);
      }
    }
  }, PRESENCE_INTERVAL_MS);
  keepAliveIntervals.push(presenceInterval);
  
  // 2. Hidden Message to self - כל 10 דקות (ברירת מחדל)
  const hiddenMsgInterval = setInterval(async () => {
    if (sock && sessionState.status === "CONNECTED" && sessionState.jid) {
      try {
        // שליחת הודעה קצרה לעצמך לשמירה על החיבור
        await sock.sendMessage(sessionState.jid, { 
          text: "🔄"
        }, {
          ephemeralExpiration: 86400 // נעלם אחרי 24 שעות
        });
        logTelemetry("HIDDEN_MESSAGE", { sent: true });
        addEvent("KEEP_ALIVE_HIDDEN", "Sent hidden message to self");
      } catch (e: any) {
        console.warn("⚠️ Hidden message failed:", e?.message);
      }
    }
  }, HIDDEN_MSG_INTERVAL_MS);
  keepAliveIntervals.push(hiddenMsgInterval);
  
  console.log(`✅ Keep-Alive Engine started: Presence(${PRESENCE_INTERVAL_MS/1000}s), Ping(60s), Hidden(${HIDDEN_MSG_INTERVAL_MS/60000}m)`);
}

function stopKeepAliveEngine() {
  if (keepAliveIntervals.length > 0) {
    keepAliveIntervals.forEach(interval => clearInterval(interval));
    keepAliveIntervals = [];
    console.log("🛑 Keep-Alive Engine stopped");
  }
}

// ============================================
// MAIN WORKER FUNCTION
// ============================================
async function startWorker() {
  console.log(`\n🚀 Starting Worker: ${SESSION_ID}`);
  addEvent("WORKER_START", `Session: ${SESSION_ID}`);
  sessionState.status = "INITIALIZING";

  // Ensure auth directory exists
  fs.ensureDirSync(AUTH_DIR);
  
  // Try to acquire session lock
  if (!acquireSessionLock()) {
    sessionState.status = "LOCKED";
    addEvent("SESSION_LOCKED", "Another container is using this session");
    console.error("❌ Session is locked by another container. Exiting...");
    process.exit(1);
  }
  
  // Verify proxy if configured
  if (PROXY_URL) {
    console.log("🌐 Verifying proxy...");
    sessionState.proxy = await verifyProxy();
    addEvent("PROXY_CHECK", sessionState.proxy.verified 
      ? `Type: ${sessionState.proxy.type}, IP: ${sessionState.proxy.externalIp}` 
      : `Failed: ${sessionState.proxy.error}`);
  }
  
  if (NO_WA_SIMULATE) {
    sessionState.status = "CONNECTED";
    sessionState.connectedAt = Date.now();
    addEvent("SIMULATION_MODE", "NO_WA_SIMULATE=true");
    await sendWebhook("CONNECTED", {
      phoneNumber: sessionState.phoneNumber || "",
      jid: sessionState.jid,
      fingerprint: `${fingerprint.os}/${fingerprint.name}/${fingerprint.version}`,
      simulated: true
    });
    startOutboxPullLoop(); // never returns
    return;
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  // Proxy agent setup - supports HTTP, HTTPS, SOCKS5, SOCKS5H
  const agent = createProxyAgent(PROXY_URL);

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: [fingerprint.os, fingerprint.name, fingerprint.version],
    syncFullHistory: false,
    agent: agent,
    connectTimeoutMs: 60000,
    retryRequestDelayMs: 5000,
    qrTimeout: 0,  // MUST: QR never expires
    generateHighQualityLinkPreview: true
  });

  // Graceful shutdown
  const shutdown = async () => {
    addEvent("SHUTDOWN", "Graceful shutdown initiated");
    stopKeepAliveEngine();
    releaseSessionLock();
    try {
      await sendWebhook("STATUS_CHANGE", { status: "SHUTTING_DOWN" });
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  // Connection events
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // QR handling
    if (qr) {
      sessionState.status = "WAITING_QR";
      sessionState.qrCount++;
      sessionState.lastQrAt = Date.now();
      
      console.log(`📱 QR Code Updated (#${sessionState.qrCount})`);
      addEvent("QR_UPDATE", `QR #${sessionState.qrCount}`);
      await sendWebhook("QR_UPDATE", { qrCode: qr });
    }

    // Connecting
    if (connection === "connecting") {
      sessionState.status = "CONNECTING";
      addEvent("CONNECTING", "Establishing connection...");
    }

    // Disconnect handling
    if (connection === "close") {
      const err = lastDisconnect?.error as any;
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;

      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      const isStreamError = err?.message?.includes("Stream Errored") || statusCode === 515;

      if (shouldReconnect || isStreamError) {
        sessionState.status = "DISCONNECTED";
        sessionState.reconnectAttempts++;
        
        // Check max reconnect attempts
        if (sessionState.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
          console.error(`❌ Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Exiting...`);
          addEvent("MAX_RECONNECTS", `Exceeded ${MAX_RECONNECT_ATTEMPTS} attempts`);
          await sendWebhook("STATUS_CHANGE", { status: "MAX_RECONNECTS_EXCEEDED" });
          releaseSessionLock();
          process.exit(1);
        }
        
        // Calculate backoff delay
        const backoffDelay = Math.min(
          RECONNECT_DELAY_MS * Math.pow(RECONNECT_BACKOFF_MULTIPLIER, sessionState.reconnectAttempts - 1),
          30000 // Max 30 seconds
        );
        
        console.log(`🔄 Reconnecting in ${backoffDelay}ms (attempt ${sessionState.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
        addEvent("RECONNECTING", `Attempt ${sessionState.reconnectAttempts}, delay: ${backoffDelay}ms, code: ${statusCode}`);
        await sendWebhook("STATUS_CHANGE", { status: "RECONNECTING", attempt: sessionState.reconnectAttempts });

        setTimeout(() => {
          startWorker().catch((e) => console.error("startWorker error:", e));
        }, backoffDelay);

        return;
      }

      // Logged out
      sessionState.status = "LOGGED_OUT";
      console.log("🚫 Session Logged Out.");
      addEvent("LOGGED_OUT", "Session terminated");
      await sendWebhook("STATUS_CHANGE", { status: "LOGGED_OUT" });

      releaseSessionLock();
      fs.emptyDirSync(AUTH_DIR);
      process.exit(1);
    }

    // Connected
    if (connection === "open") {
      sessionState.status = "CONNECTED";
      sessionState.connectedAt = Date.now();
      sessionState.reconnectAttempts = 0; // Reset on successful connection
      
      const user = sock!.user;
      const decoded = jidDecode(user?.id);
      const phoneNumber = decoded?.user || "";

      sessionState.phoneNumber = phoneNumber;
      sessionState.jid = user?.id || null;

      console.log(`✅ Connected: ${phoneNumber}`);
      addEvent("CONNECTED", `Phone: ${phoneNumber}`);
      
      await sendWebhook("CONNECTED", {
        phoneNumber: phoneNumber,
        jid: user?.id,
        fingerprint: `${fingerprint.os}/${fingerprint.name}/${fingerprint.version}`
      });
      
      // Start Keep-Alive Engine (Anti-Ban)
      startKeepAliveEngine();
      
      // Process any queued messages
      processMessageQueue();
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // Ping every minute + refresh lock
  setInterval(() => {
    sessionState.lastPingAt = Date.now();
    refreshLock();
    sendWebhook("PING", { 
      status: "ALIVE",
      uptime: Date.now() - sessionState.startTime,
      messagesSent: sessionState.messagesSent
    });
    logTelemetry("PING", { uptime: Date.now() - sessionState.startTime });
  }, 60000);

  // Start outbox pull loop (runs independently)
  startOutboxPullLoop();
}

// ============================================
// START EVERYTHING
// ============================================
console.log("═".repeat(60));
console.log("  WhatsApp Worker Starting");
console.log("═".repeat(60));
console.log(`  Session ID: ${SESSION_ID}`);
console.log(`  Fingerprint: ${fingerprint.os}/${fingerprint.name}/${fingerprint.version}`);
console.log(`  Webhook URL: ${WEBHOOK_URL || "(not configured)"}`);
console.log(`  Orchestrator URL: ${ORCHESTRATOR_URL || "(not configured)"}`);
console.log(`  Outbox Pull: ${ENABLE_OUTBOX_PULL ? "ENABLED" : "DISABLED"}`);
if (NO_WA_SIMULATE) console.log(`  WhatsApp: SIMULATION (NO_WA_SIMULATE=true)`);
console.log(`  Proxy: ${PROXY_URL ? PROXY_URL.replace(/:[^:@]+@/, ':***@') : "(none)"}`);
console.log(`  Mode: ${ENABLE_API_SERVER ? "DEBUG (API server enabled)" : "PRODUCTION (no ports exposed)"}`);
if (ENABLE_SEND_DELAY) {
  console.log(`  Message Delay: ${MESSAGE_DELAY_MIN}-${MESSAGE_DELAY_MAX}ms`);
} else {
  console.log(`  Message Delay: DISABLED (Orchestrator controls)`);
}
console.log(`  Max Reconnects: ${MAX_RECONNECT_ATTEMPTS}`);
if (ENABLE_KEEP_ALIVE) {
  console.log(`  Keep-Alive: ENABLED (Presence: ${PRESENCE_INTERVAL_MS/1000}s, Hidden: ${HIDDEN_MSG_INTERVAL_MS/60000}m)`);
} else {
  console.log(`  Keep-Alive: DISABLED`);
}
console.log("═".repeat(60));

// Start API server ONLY in debug mode
if (ENABLE_API_SERVER) {
  console.log("⚠️  DEBUG MODE: API server enabled on port " + API_PORT);
  startApiServer();
} else {
  console.log("✅ PRODUCTION MODE: No ports exposed, webhook-only");
}

// Start WhatsApp worker
startWorker().catch((e) => {
  console.error("Fatal start error:", e);
  addEvent("FATAL_ERROR", e?.message || "Unknown error");
  releaseSessionLock();
  process.exit(1);
});
