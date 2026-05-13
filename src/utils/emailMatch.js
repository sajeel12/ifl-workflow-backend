// Compare two email addresses by the local-part (text before the "@") only,
// case-insensitively. The same person can show up as ali.khan@ifl.net in
// HRMS and ali.khan@igc.com.pk in AD; for forwarded-email identity checks
// we treat those as the same user.
//
// Returns false when either side is missing the "@" or is empty.
export function emailLocalPart(email) {
    if (!email || typeof email !== 'string') return '';
    const at = email.indexOf('@');
    if (at <= 0) return '';
    return email.slice(0, at).toLowerCase().trim();
}

export function emailsMatch(a, b) {
    const la = emailLocalPart(a);
    const lb = emailLocalPart(b);
    return !!la && la === lb;
}
