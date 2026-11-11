'use strict';

// RouterOS expresses durations like "3h", "1h30m", "2d4h", "59m59s" (and sometimes "00:10:00").

const UNIT_SECONDS = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };

function parseRosDuration(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  if (typeof value !== 'string') return 0;
  const s = value.trim();
  if (s === '') return 0;
  if (/^\d+$/.test(s)) return Number(s);

  const clock = s.match(/^(?:(\d+)d\s*)?(\d{1,3}):(\d{2}):(\d{2})$/);
  if (clock) {
    return Number(clock[1] || 0) * 86400 + Number(clock[2]) * 3600 + Number(clock[3]) * 60 + Number(clock[4]);
  }

  if (!/^(\d+(ms|w|d|h|m|s))+$/.test(s)) return 0;
  let total = 0;
  for (const m of s.matchAll(/(\d+)(ms|w|d|h|m|s)/g)) {
    if (m[2] === 'ms') continue;
    total += Number(m[1]) * UNIT_SECONDS[m[2]];
  }
  return total;
}

function formatRosDuration(totalSeconds) {
  let s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  if (s === 0) return '0s';
  const parts = [];
  for (const [unit, size] of [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]]) {
    const n = Math.floor(s / size);
    if (n > 0) {
      parts.push(n + unit);
      s -= n * size;
    }
  }
  return parts.join('');
}

// "2h 59m", "45m", "30s" for people.
function humanDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

module.exports = { parseRosDuration, formatRosDuration, humanDuration };
