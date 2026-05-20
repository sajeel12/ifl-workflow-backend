import { randomUUID } from 'crypto';

const TTL_MS = 8 * 60 * 60 * 1000; // 8-hour portal session

// token → { roleKey, email, accesses: [{location, isPrimary}], roleName, expiresAt }
const store = new Map();

export function issueToken(payload) {
    const token = randomUUID();
    store.set(token, { ...payload, expiresAt: Date.now() + TTL_MS });
    return token;
}

export function validateToken(token) {
    const entry = store.get(token);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { store.delete(token); return null; }
    return entry;
}

// Periodic cleanup so the Map doesn't grow unbounded on a long-running server.
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of store) {
        if (now > v.expiresAt) store.delete(k);
    }
}, 60 * 60 * 1000); // prune hourly
