class TaskQueue {
  constructor({ name = "queue" } = {}) {
    this.name = name;
    this.queue = [];
    this.processing = false;
    this.totalEnqueued = 0;
    this.totalProcessed = 0;
    this.totalFailed = 0;
  }

  getStats() {
    return {
      name: this.name,
      pending: this.queue.length,
      processing: this.processing,
      totalEnqueued: this.totalEnqueued,
      totalProcessed: this.totalProcessed,
      totalFailed: this.totalFailed
    };
  }

  enqueue(taskFn) {
    if (typeof taskFn !== "function") {
      throw new Error("enqueue expects a function");
    }

    this.totalEnqueued += 1;
    this.queue.push(taskFn);

    // Fire-and-forget processing.
    // We intentionally do not return a promise to avoid coupling HTTP response to processing.
    this.#drain().catch(() => {
      // drain() already counts failures; swallow to avoid unhandled rejection.
    });
  }

  async #drain() {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const task = this.queue.shift();
        try {
          await task();
          this.totalProcessed += 1;
        } catch (err) {
          this.totalFailed += 1;
          // eslint-disable-next-line no-console
          console.error(`[${this.name}] task failed`, err);
        }
      }
    } finally {
      this.processing = false;
    }
  }
}

module.exports = { TaskQueue };


