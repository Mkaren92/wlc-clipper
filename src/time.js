/**
 * Parse a timestamp given as seconds, mm:ss or hh:mm:ss. Decimals are allowed
 * on the seconds part only.
 *
 * @param {string} text
 * @returns {number} seconds
 */
export function parseTime(text) {
  const input = String(text).trim();
  const parts = input.split(':');
  const fail = () =>
    new Error(`"${text}" is not a time. Use seconds, mm:ss or hh:mm:ss, such as 754.5, 12:34.5 or 1:02:03.`);

  if (parts.length > 3) throw fail();
  const secondsText = parts.pop();
  if (!/^\d+(\.\d+)?$/.test(secondsText)) throw fail();
  if (parts.some((part) => !/^\d+$/.test(part))) throw fail();

  const seconds = Number(secondsText);
  if (parts.length === 0) return seconds;

  const minutes = Number(parts.pop());
  const hours = parts.length ? Number(parts.pop()) : 0;
  // With a colon, seconds must be a clock value. Minutes may exceed 59 only
  // when there is no hours part ("90:00" means ninety minutes).
  if (seconds >= 60) throw fail();
  if (input.split(':').length === 3 && minutes >= 60) throw fail();

  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Format seconds for display as m:ss.cc, or h:mm:ss.cc from one hour up.
 * Rounds to hundredths first, so 59.999 becomes 1:00.00 and never 0:60.00.
 *
 * @param {number} seconds
 * @returns {string}
 */
export function formatClock(seconds) {
  const totalCs = Math.round(seconds * 100);
  const cs = totalCs % 100;
  const totalSeconds = (totalCs - cs) / 100;
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const two = (n) => String(n).padStart(2, '0');
  const tail = `${two(s)}.${two(cs)}`;
  return h > 0 ? `${h}:${two(m)}:${tail}` : `${m}:${tail}`;
}

/**
 * Format seconds the way subtitle files want them: H:MM:SS.cc, always with
 * the hour and two decimals.
 *
 * @param {number} seconds
 * @returns {string}
 */
export function formatAssTime(seconds) {
  const totalCs = Math.max(0, Math.round(seconds * 100));
  const cs = totalCs % 100;
  const totalSeconds = (totalCs - cs) / 100;
  const two = (n) => String(n).padStart(2, '0');
  return `${Math.floor(totalSeconds / 3600)}:${two(Math.floor(totalSeconds / 60) % 60)}:${two(totalSeconds % 60)}.${two(cs)}`;
}
