// backend/events/adminEventBus.js
// ============================================================
// Shatova — Admin Real-Time Event Bus
// Tiny in-process pub/sub for pushing admin alerts over SSE.
// ============================================================
import { EventEmitter } from 'events';

class AdminEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(200);
  }

  emitApproval(type, item) {
    if (!type || !item) return;
    try {
      this.emit('new-approval', { type, item, ts: Date.now() });
    } catch (err) {
      console.error('[adminEventBus] emitApproval failed:', err?.message || err);
    }
  }

  emitAdmin(eventName, payload = {}) {
    if (!eventName) return;
    try {
      this.emit(eventName, { ...payload, ts: Date.now() });
    } catch (err) {
      console.error('[adminEventBus] emitAdmin failed:', err?.message || err);
    }
  }
}

export const adminEventBus = new AdminEventBus();
export default adminEventBus;
