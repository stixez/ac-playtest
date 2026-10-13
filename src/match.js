// Filters for recorded messages and events: either a predicate function or an object of expected fields.

/**
 * Whether a message reached device `to`: sent to it directly, or broadcast by another device, unless it was
 * dropped because the device's page had not loaded (`undelivered`). A queued message counts once it was delivered
 * (`delivered`, filled in from 'messageDelivered' events). `to: 'all'` matches broadcasts.
 */
export function reached(message, to) {
  if (to === 'all') return message.to === 'all';
  if (message.delivered && message.delivered.includes(to)) return true;
  const addressed = message.to === to || (message.to === 'all' && message.from !== to);
  return addressed && !(message.undelivered && message.undelivered.includes(to));
}

/**
 * Message filter: {from, to, type} where `type` is compared with `message.data.type` (a common convention), and
 * `to: n` means "delivered to device n" (see reached()).
 */
export function messageMatcher(filter) {
  if (filter == null) return () => true;
  if (typeof filter === 'function') return filter;
  const unknown = Object.keys(filter).filter((k) => !['from', 'to', 'type'].includes(k));
  if (unknown.length) {
    throw new TypeError(`message filter: unknown key(s) ${unknown.join(', ')}; use {from, to, type} or a function`);
  }
  return (m) => {
    if (filter.from !== undefined && m.from !== filter.from) return false;
    if (filter.to !== undefined && !reached(m, filter.to)) return false;
    if (filter.type !== undefined && (m.data == null || m.data.type !== filter.type)) return false;
    return true;
  };
}

/** Event filter: every given field must be strictly equal, e.g. {type: 'connect', device: 2}. */
export function eventMatcher(filter) {
  if (filter == null) return () => true;
  if (typeof filter === 'function') return filter;
  return (e) => Object.keys(filter).every((key) => e[key] === filter[key]);
}

export function describeFilter(filter) {
  if (typeof filter === 'function') return filter.name || 'predicate';
  return JSON.stringify(filter);
}
