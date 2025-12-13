const Docker = require("dockerode");

const { config } = require("../config");
const { getInventoryStatus } = require("../services/inventoryService");
const { alertLowInventory } = require("../services/alertService");
const { getDb } = require("../infra/db");

function createDockerClient() {
  // Default works on Linux (socket) and Windows with proper Docker setup.
  return new Docker();
}

async function provisioningTick() {
  const inventory = await getInventoryStatus();

  if (inventory.profiles.available === 0 || inventory.proxies.available === 0) {
    await alertLowInventory({
      profilesAvailable: inventory.profiles.available,
      proxiesAvailable: inventory.proxies.available
    });
    return;
  }

  // Placeholder:
  // - pick a profile from profiles:available and mark USED
  // - pick a proxy using allocation rules
  // - create binding in SQLite + Redis
  // - docker run bot container with env vars
}

async function monitorTick() {
  // Placeholder:
  // - ping containers
  // - detect disconnects / proxy errors
  // - perform recovery procedure
}

function startOrchestratorRunner() {
  // Init infra early (db schema)
  getDb().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[orchestrator] db init failed", err);
  });

  // Ensure docker client can be created (even if not used yet).
  createDockerClient();

  setInterval(() => {
    provisioningTick().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[orchestrator] provisioning tick failed", err);
    });
  }, config.provisioningIntervalMs);

  setInterval(() => {
    monitorTick().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[orchestrator] monitor tick failed", err);
    });
  }, config.monitorIntervalMs);
}

module.exports = { startOrchestratorRunner };


