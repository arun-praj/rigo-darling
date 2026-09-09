/** Runs in the page as well as fixture tests; keep this function self-contained. */
export function readAttendanceDom(target: { day: number; weekday: string }): { checkIn?: string; checkOut?: string } {
  const headings = [...document.querySelectorAll('h1, h2, h3')].filter(e => /^my\s+time\s+and\s+attendance$/i.test(e.textContent?.trim() || ''));
  if (headings.length !== 1) throw new Error('attendance-heading-missing-or-ambiguous');
  const rows = [...(headings[0].parentElement?.querySelectorAll('[dir="row"]') || [])];
  const matching = rows.filter(row => {
    // Read only the date badge, never timestamp text elsewhere in the row.
    const label = row.firstElementChild;
    const parts = [...(label?.querySelectorAll('p') || [])].map(e => e.textContent?.trim() || '');
    return parts.length === 2 && /^\d{1,2}$/.test(parts[0]) && Number(parts[0]) === target.day && parts[1] === target.weekday;
  });
  if (matching.length !== 1) throw new Error(matching.length ? 'date-row-ambiguous' : 'date-row-not-found');
  const result: { checkIn?: string; checkOut?: string } = {};
  for (const badge of [...matching[0].children].slice(1)) {
    const text = badge.textContent?.trim() || '';
    if (!/\d/.test(text)) {
      if (/^(Time|Leave|Check[- ]?in|Check[- ]?out)?$/i.test(text)) continue;
      throw new Error('attendance-badge-unrecognized');
    }
    if (!/^(?:[1-9]|1[0-2]):[0-5]\d\s*[ap](?:m)?$/i.test(text)) throw new Error('attendance-time-unrecognized');
    const classes = badge.querySelector('svg')?.getAttribute('class') || '';
    const isIn = classes.includes('arrow-down-left');
    const isOut = classes.includes('arrow-up-right');
    if (isIn === isOut) throw new Error('attendance-direction-unrecognized');
    const key = isIn ? 'checkIn' : 'checkOut';
    if (result[key]) throw new Error('attendance-direction-ambiguous');
    result[key] = text;
  }
  return result;
}
