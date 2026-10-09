// Filters for recorded messages and events: either a predicate function or an object of expected fields.

/**
 * Message filter: {from, to, type} where `type` is compared with `message.data.type` (a common convention), and
 * `to: n` also matches broadcasts that reached device n (any broadcast not sent by n itself).
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
    if (filter.to !== undefined && m.to !== filter.to && !(m.to === 'all' && filter.to !== 'all' && m.from !== filter.to)) return false;
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
