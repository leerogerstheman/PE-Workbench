'use strict';

/**
 * Graceful shutdown hook, shared between the HTTP layer (which can receive a
 * `/api/shutdown` request from the desktop launcher) and the entry point
 * (which owns the shutdown sequence: stop the monitor, flush WAL, exit 0).
 *
 * Kept in its own module because `routes` and `server` require each other's
 * services; a hook registry breaks the cycle.
 */

let hook = null;
let hookName = null;

function register(name, fn) {
  hook = { name, fn };
  hookName = name;
}

function trigger(reason) {
  if (!hook) return { ok: false, reason: 'no shutdown hook registered yet' };
  // Defer so the HTTP response can be sent before the process exits.
  setImmediate(() => hook.fn(reason || hookName));
  return { ok: true };
}

module.exports = { register, trigger, hookName };