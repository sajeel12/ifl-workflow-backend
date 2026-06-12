// Fixed location groups for workflow routing. Per client policy, these are
// the only valid location buckets — we no longer derive locations from HRMS.
// Each group has a stable `key` (used in DB rows / request.location), a
// `label` (admin UI + PDF), and the list of physical locations that map to it.

export const LOCATION_GROUPS = [
    { key: 'LHR',         label: 'LHR',                                          locations: ['LHR'] },
    { key: 'HO_FSD',      label: 'HO / ISB / MUL / P10 / SIDHUPURA / KHI',       locations: ['HO', 'ISB', 'MUL', 'P10', 'SIDHUPURA', 'KHI'] },
    { key: 'TP3_TP4_PG',  label: 'TP3 / TP4 / PG',                               locations: ['TP3', 'TP4', 'PG'] },
    { key: 'PP',          label: 'PP',                                           locations: ['PP'] },
    { key: 'TP1_TP2',     label: 'TP1 / TP2',                                    locations: ['TP1', 'TP2'] }
];

const GROUP_KEY_SET = new Set(LOCATION_GROUPS.map(g => g.key));

// Build a flat physical-location → group-key map (case-insensitive).
const PHYSICAL_TO_GROUP = (() => {
    const m = new Map();
    for (const g of LOCATION_GROUPS) {
        for (const loc of g.locations) m.set(loc.toUpperCase(), g.key);
    }
    return m;
})();

// Return the group key for any raw location string. Accepts either a
// physical location ("HO", "MUL") or a group key already ("HO_FSD").
// Returns null when nothing matches.
export function groupKeyForLocation(loc) {
    if (!loc || typeof loc !== 'string') return null;
    const norm = loc.trim().toUpperCase();
    if (GROUP_KEY_SET.has(norm)) return norm;
    return PHYSICAL_TO_GROUP.get(norm) || null;
}

// Resolve a group object (key + label + locations) by its key. Returns null
// for unknown keys.
export function groupByKey(key) {
    if (!key) return null;
    return LOCATION_GROUPS.find(g => g.key === key) || null;
}

// Pretty-print a group key for display (falls back to the key itself).
export function groupLabel(key) {
    const g = groupByKey(key);
    return g ? g.label : (key || '');
}

export function isValidGroupKey(key) {
    return !!key && GROUP_KEY_SET.has(String(key).toUpperCase());
}

// Normalize a free-text location/office label for map lookups: trim, lowercase,
// collapse internal whitespace. e.g. "  Head   Office " → "head office".
export function normalizeLoc(s) {
    return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Resolve a group key from a free-text AD office name (physicalDeliveryOfficeName),
// e.g. "Head Office" → "HO_FSD", "Lahore" → "LHR". Resolution order:
//   1. the admin-configured alias map (normalized office name → group key),
//   2. groupKeyForLocation() in case the office is already a site/group code,
//   3. null when nothing maps.
// `aliasMap` is a plain object { normalizedOfficeName: groupKey } (caller loads
// it from SystemConfig so this stays DB-free and easy to unit-test).
export function groupKeyForAdOffice(adOffice, aliasMap = {}) {
    if (!adOffice) return null;
    const norm = normalizeLoc(adOffice);
    const mapped = aliasMap && aliasMap[norm];
    if (mapped && isValidGroupKey(mapped)) return String(mapped).toUpperCase();
    return groupKeyForLocation(adOffice);
}
