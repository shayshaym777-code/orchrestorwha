/**
 * Runner Service
 * 
 * Manages Docker containers for WhatsApp Worker sessions.
 * Uses dockerode to create/start/stop containers.
 */

const Docker = require("dockerode");
const { config } = require("../config");
const { getSession, updateSessionStatus, SessionStatus } = require("./sessionRegistry");

// Docker client (connects to local Docker daemon)
const docker = new Docker();

// Configuration
const WORKER_IMAGE = process.env.WORKER_IMAGE || "whatsapp-worker-image:1.0.0";
const SESSIONS_VOLUME_PATH = process.env.SESSIONS_VOLUME_PATH || "/data/wa-sessions";
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL || "http://host.docker.internal:3000";
const GATEWAY_BASE_URL = process.env.GATEWAY_BASE_URL || "http://host.docker.internal:4000";
const MEDIA_INTERNAL_KEY = process.env.MEDIA_INTERNAL_KEY || "";

/**
 * Start a worker container for a session
 * 
 * @param {string} sessionId - The session ID
 * @param {object} options - Optional overrides
 * @returns {Promise<{success: boolean, containerId?: string, error?: string}>}
 */
async function startWorker(sessionId, options = {}) {
  try {
    // Get session from registry
    const session = await getSession(sessionId);
    if (!session) {
      return { success: false, error: "SESSION_NOT_FOUND" };
    }

    const { phone, proxy } = session;
    
    // Container name
    const containerName = `wa_session_${sessionId}`;
    
    // Check if container already exists
    try {
      const existing = docker.getContainer(containerName);
      const info = await existing.inspect();
      
      if (info.State.Running) {
        return { success: false, error: "CONTAINER_ALREADY_RUNNING", containerId: info.Id };
      }
      
      // Container exists but not running - remove it
      await existing.remove({ force: true });
    } catch (e) {
      // Container doesn't exist - that's fine
    }

    // Environment variables
    const env = [
      `SESSION_ID=${sessionId}`,
      `WEBHOOK_URL=${options.webhookUrl || `${WEBHOOK_BASE_URL}/api/webhook`}`,
      `WEBHOOK_SECRET=${options.webhookSecret || config.webhookSecret || ""}`,
      // Outbox pull (worker claims tasks from Orchestrator queues)
      `ORCHESTRATOR_URL=${options.orchestratorUrl || WEBHOOK_BASE_URL}`,
      `ENABLE_OUTBOX_PULL=${options.enableOutboxPull === false ? "false" : "true"}`,
      `OUTBOX_CLAIM_TIMEOUT=${options.outboxClaimTimeout || 20}`,
      // Media (image mode): worker downloads from Gateway internal endpoint
      `MEDIA_BASE_URL=${options.gatewayBaseUrl || GATEWAY_BASE_URL}`,
      `MEDIA_INTERNAL_KEY=${options.mediaInternalKey || MEDIA_INTERNAL_KEY}`
    ];
    
    // Add proxy if available
    if (proxy && proxy !== "none") {
      env.push(`PROXY_URL=${proxy}`);
    }
    
    // Add optional env vars
    if (options.enableApiServer) {
      env.push("ENABLE_API_SERVER=true");
      env.push(`API_PORT=${options.apiPort || 3001}`);
    }
    
    // Default: let Dispatcher control pacing. Worker-side delay can be re-enabled explicitly.
    if (options.enableSendDelay !== true) {
      env.push("ENABLE_SEND_DELAY=false");
    }

    // Volume binding
    const hostPath = `${options.sessionsPath || SESSIONS_VOLUME_PATH}/${sessionId}`;
    const containerPath = `/app/sessions/${sessionId}`;
    
    // Create container
    const container = await docker.createContainer({
      Image: WORKER_IMAGE,
      name: containerName,
      Env: env,
      HostConfig: {
        Binds: [`${hostPath}:${containerPath}`],
        RestartPolicy: {
          Name: options.restartPolicy || "unless-stopped",
          MaximumRetryCount: 0
        },
        // Add extra hosts for host.docker.internal on Linux
        ExtraHosts: ["host.docker.internal:host-gateway"]
      },
      Labels: {
        "wa.session.id": sessionId,
        "wa.session.phone": phone || "",
        "wa.managed": "true"
      }
    });

    // Start container
    await container.start();
    
    // Update session status
    await updateSessionStatus(sessionId, SessionStatus.PROVISIONING, {
      containerId: container.id,
      containerName,
      startedAt: Date.now().toString()
    });

    return { 
      success: true, 
      containerId: container.id,
      containerName,
      sessionId
    };
    
  } catch (error) {
    console.error(`[Runner] Failed to start worker for ${sessionId}:`, error.message);
    return { 
      success: false, 
      error: error.message || "DOCKER_ERROR"
    };
  }
}

/**
 * Stop a worker container
 * 
 * @param {string} sessionId - The session ID
 * @param {object} options - Optional settings
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function stopWorker(sessionId, options = {}) {
  try {
    const containerName = `wa_session_${sessionId}`;
    const container = docker.getContainer(containerName);
    
    try {
      const info = await container.inspect();
      
      if (info.State.Running) {
        // Graceful stop with timeout
        await container.stop({ t: options.timeout || 10 });
      }
      
      // Remove container if requested
      if (options.remove !== false) {
        await container.remove({ force: true });
      }
      
      return { success: true, containerId: info.Id };
      
    } catch (e) {
      if (e.statusCode === 404) {
        return { success: true, message: "Container not found (already removed)" };
      }
      throw e;
    }
    
  } catch (error) {
    console.error(`[Runner] Failed to stop worker for ${sessionId}:`, error.message);
    return { 
      success: false, 
      error: error.message || "DOCKER_ERROR"
    };
  }
}

/**
 * Restart a worker container
 * 
 * @param {string} sessionId - The session ID
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function restartWorker(sessionId) {
  try {
    const containerName = `wa_session_${sessionId}`;
    const container = docker.getContainer(containerName);
    
    await container.restart({ t: 10 });
    
    const info = await container.inspect();
    
    return { 
      success: true, 
      containerId: info.Id,
      state: info.State.Status
    };
    
  } catch (error) {
    console.error(`[Runner] Failed to restart worker for ${sessionId}:`, error.message);
    return { 
      success: false, 
      error: error.message || "DOCKER_ERROR"
    };
  }
}

/**
 * Get worker container status
 * 
 * @param {string} sessionId - The session ID
 * @returns {Promise<{exists: boolean, running?: boolean, info?: object}>}
 */
async function getWorkerStatus(sessionId) {
  try {
    const containerName = `wa_session_${sessionId}`;
    const container = docker.getContainer(containerName);
    
    const info = await container.inspect();
    
    return {
      exists: true,
      running: info.State.Running,
      status: info.State.Status,
      startedAt: info.State.StartedAt,
      containerId: info.Id,
      containerName
    };
    
  } catch (error) {
    if (error.statusCode === 404) {
      return { exists: false };
    }
    throw error;
  }
}

/**
 * Get logs from worker container
 * 
 * @param {string} sessionId - The session ID
 * @param {object} options - Log options
 * @returns {Promise<string>}
 */
async function getWorkerLogs(sessionId, options = {}) {
  try {
    const containerName = `wa_session_${sessionId}`;
    const container = docker.getContainer(containerName);
    
    const logs = await container.logs({
      stdout: true,
      stderr: true,
      tail: options.tail || 100,
      timestamps: options.timestamps || false
    });
    
    return logs.toString("utf8");
    
  } catch (error) {
    console.error(`[Runner] Failed to get logs for ${sessionId}:`, error.message);
    throw error;
  }
}

/**
 * List all managed worker containers
 * 
 * @returns {Promise<Array>}
 */
async function listWorkers() {
  try {
    const containers = await docker.listContainers({
      all: true,
      filters: {
        label: ["wa.managed=true"]
      }
    });
    
    return containers.map(c => ({
      containerId: c.Id,
      containerName: c.Names[0]?.replace("/", ""),
      sessionId: c.Labels["wa.session.id"],
      phone: c.Labels["wa.session.phone"],
      state: c.State,
      status: c.Status,
      created: c.Created
    }));
    
  } catch (error) {
    console.error("[Runner] Failed to list workers:", error.message);
    return [];
  }
}

module.exports = {
  startWorker,
  stopWorker,
  restartWorker,
  getWorkerStatus,
  getWorkerLogs,
  listWorkers,
  // Export config for reference
  WORKER_IMAGE,
  SESSIONS_VOLUME_PATH,
  WEBHOOK_BASE_URL
};

