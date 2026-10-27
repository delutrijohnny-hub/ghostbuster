// Deterministic observations only. Unknown delivery never becomes sent.
export function inspectSnapshot(clients, messages, now = Date.now()) {
  const findings = [];
  const phones = new Map();
  for (const c of clients) {
    const phone = String(c.phone || '').replace(/\D/g, '');
    if (phone) phones.set(phone, [...(phones.get(phone) || []), c]);
    if (c.ignored || c.close_outcome === 'Closed') continue;
    const when = Date.parse(c.call_date_time);
    if (Number.isFinite(when) && when < now && ['Booked','Confirmed','Reminded'].includes(c.status))
      findings.push({kind:'missing_outcome', client_ids:[c.id], detail:`${c.name}: past appointment still marked ${c.status}. Review its outcome.`});
    if (Number.isFinite(when) && when >= now && when <= now + 86400000 && c.status === 'Booked')
      findings.push({kind:'upcoming_unconfirmed', client_ids:[c.id], detail:`${c.name}: appointment within 24 hours is marked Booked, not Confirmed.`});
  }
  for (const group of phones.values()) if (group.length > 1)
    findings.push({kind:'possible_duplicate', client_ids:group.map(c=>c.id), detail:`${group.map(c=>c.name).join(', ')} share an exact normalized phone number. Review; do not merge automatically.`});
  const unconfirmed = messages.filter(m => m.delivery_status === 'unverified');
  if (unconfirmed.length) findings.push({kind:'unconfirmed_sends', client_ids:[...new Set(unconfirmed.map(m=>m.client_id))], detail:`${unconfirmed.length} loaded messages were opened externally; sending is unconfirmed.`});
  return findings;
}
export function ownedRows(rows, ids) { return rows.filter(r => ids.has(r.client_id)); }
