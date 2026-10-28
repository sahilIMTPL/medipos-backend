/**
 * High-Performance Asynchronous Background Task Queue
 * Decouples heavy non-blocking operations (journal postings, audit logging, analytics)
 * from synchronous POS checkout and API response latency.
 */

export type TaskType =
  | "RECORD_AUDIT_LOG"
  | "POST_SALES_JOURNAL"
  | "POST_PURCHASE_JOURNAL"
  | "REFRESH_ANALYTICS";

export interface QueueTask {
  id: string;
  type: TaskType;
  payload: any;
  retries: number;
  maxRetries: number;
  enqueuedAt: number;
}

class AsyncTaskQueue {
  private queue: QueueTask[] = [];
  private concurrency: number;
  private activeWorkers = 0;
  private handlers = new Map<TaskType, (payload: any) => Promise<any>>();

  constructor(concurrency = 5) {
    this.concurrency = concurrency;
  }

  registerHandler(type: TaskType, handler: (payload: any) => Promise<any>): void {
    this.handlers.set(type, handler);
  }

  enqueue(type: TaskType, payload: any, maxRetries = 3): string {
    const taskId = `task-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const task: QueueTask = {
      id: taskId,
      type,
      payload,
      retries: 0,
      maxRetries,
      enqueuedAt: Date.now(),
    };

    this.queue.push(task);
    this.processNext();
    return taskId;
  }

  private async processNext(): Promise<void> {
    if (this.activeWorkers >= this.concurrency || this.queue.length === 0) {
      return;
    }

    const task = this.queue.shift();
    if (!task) return;

    this.activeWorkers++;

    try {
      const handler = this.handlers.get(task.type);
      if (handler) {
        await handler(task.payload);
      } else {
        console.warn(`[AsyncTaskQueue] No registered handler for task type: ${task.type}`);
      }
    } catch (err: any) {
      console.error(`[AsyncTaskQueue] Task ${task.id} (${task.type}) failed:`, err?.message || err);

      if (task.retries < task.maxRetries) {
        task.retries++;
        // Re-enqueue with progressive backoff (500ms, 1000ms, 2000ms)
        const delay = Math.pow(2, task.retries) * 250;
        setTimeout(() => {
          this.queue.push(task);
          this.processNext();
        }, delay);
      } else {
        console.error(`[AsyncTaskQueue] Task ${task.id} (${task.type}) permanently failed after ${task.maxRetries} retries.`);
      }
    } finally {
      this.activeWorkers--;
      // Continue draining queue
      this.processNext();
    }
  }

  getPendingCount(): number {
    return this.queue.length;
  }

  getActiveCount(): number {
    return this.activeWorkers;
  }
}

export const taskQueue = new AsyncTaskQueue(5);

