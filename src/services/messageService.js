/**
 * This layer should forward the validated payload to your actual delivery system:
 * WhatsApp provider, queue, workers, etc.
 *
 * Important: no business logic here (anti-ban, retry, scheduling) unless YOU decide.
 */
const { TaskQueue } = require("./taskQueue");

const messageQueue = new TaskQueue({ name: "message-intake" });

async function processMessageJob(payload) {
  // Placeholder for your real integration:
  // - push to Redis/BullMQ
  // - send to WhatsApp provider
  // - write to DB, etc.

  // eslint-disable-next-line no-console
  console.log(
    `[message-intake] processing job for ${payload.contacts.length} contacts (hasImage=${Boolean(
      payload.image
    )})`
  );
}

async function intakeMessage(payload) {
  // Queue requests so only ONE job is processed at a time (FIFO).
  // Note: intakeMessage returns immediately (after enqueue).
  messageQueue.enqueue(async () => processMessageJob(payload));
}

module.exports = { intakeMessage };


