/**
 * Common ISO date utilities for AdvocateVox.
 * Enforces strict, timezone-independent ISO 8601 YYYY-MM-DD calendar date validation and formatting.
 */

export const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates that `value` is a valid ISO calendar date (YYYY-MM-DD).
 * Parses in UTC to guarantee invariant behavior across all machine timezones.
 * Rejects nonexistent calendar dates like 2023-02-29, 2021-04-31, or invalid types.
 */
export const isValidIsoDate = (value) => {
  if (typeof value !== 'string' || !ISO_DATE_REGEX.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(time)) return false;
  return new Date(time).toISOString().slice(0, 10) === value;
};

/**
 * Asserts that `value` is a valid ISO date string, throwing TypeError if invalid.
 */
export const assertIsoDate = (value, field = 'date') => {
  if (!isValidIsoDate(value)) {
    throw new TypeError(`${field} must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(value)}`);
  }
};

/**
 * Safely parses any date string, timestamp, or Date object into a YYYY-MM-DD UTC date string, or null if invalid.
 */
export const toIsoDay = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const time = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString().slice(0, 10);
};

const INDIA_DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Returns the current date in Asia/Kolkata as YYYY-MM-DD.
 */
export const todayKolkata = (instant = new Date()) => {
  const fields = Object.fromEntries(
    INDIA_DATE_FORMAT.formatToParts(instant)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${fields.year}-${fields.month}-${fields.day}`;
};

/**
 * Returns the current date in UTC as YYYY-MM-DD.
 */
export const todayUtc = (instant = new Date()) => {
  return new Date(instant).toISOString().slice(0, 10);
};

