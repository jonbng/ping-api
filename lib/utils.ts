/**
 * Shared utility functions for the Lectio API
 */

/**
 * Calculate ISO week key from a date
 * Returns format: WWYYYY (e.g., "452025" for week 45 of 2025)
 *
 * ISO week date rules:
 * - Week 1 is the week containing the first Thursday of the year
 * - Monday is the first day of the week
 * - Weeks can span across year boundaries
 */
export const getWeekKey = (date: Date): string => {
  // ISO week date calculation
  const target = new Date(date.valueOf());
  const dayNumber = (date.getDay() + 6) % 7; // Monday = 0, Sunday = 6
  target.setDate(target.getDate() - dayNumber + 3); // Thursday of current week
  const firstThursday = new Date(target.getFullYear(), 0, 4); // Jan 4th is always in week 1
  const weekNumber = Math.ceil(
    ((target.getTime() - firstThursday.getTime()) / 86400000 + 1) / 7
  );
  const year = target.getFullYear();
  return `${weekNumber.toString().padStart(2, "0")}${year.toString()}`;
};

/**
 * Remove undefined values from an object (Firestore doesn't allow undefined)
 * Recursively processes nested objects
 */
export function removeUndefined<T extends Record<string, any>>(obj: T): T { // eslint-disable-line
  const cleaned = {} as T;
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        cleaned[key as keyof T] = removeUndefined(value) as T[keyof T];
      } else {
        cleaned[key as keyof T] = value;
      }
    }
  }
  return cleaned;
}
