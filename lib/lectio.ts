import { db } from "@/lib/firebase-admin";

/**
 * Remove undefined values from an object (Firestore doesn't allow undefined)
 */
function removeUndefined<T extends Record<string, any>>(obj: T): T { // eslint-disable-line
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

/**
 * Parse expiration date from Set-Cookie header
 * @param cookieString - The Set-Cookie header string for a specific cookie
 * @returns ISO string of expiration date, or undefined if not found
 */
function parseExpiration(cookieString: string): string | undefined {
  // Check for expires= attribute
  const expiresMatch = cookieString.match(/expires=([^;]+)/i);
  if (expiresMatch) {
    const expiresDate = new Date(expiresMatch[1]);
    if (!isNaN(expiresDate.getTime())) {
      return expiresDate.toISOString();
    }
  }

  // Check for max-age= attribute
  const maxAgeMatch = cookieString.match(/max-age=(\d+)/i);
  if (maxAgeMatch) {
    const maxAge = parseInt(maxAgeMatch[1], 10);
    const expiresDate = new Date(Date.now() + maxAge * 1000);
    return expiresDate.toISOString();
  }

  return undefined;
}

/**
 * Parse all cookies from Set-Cookie header
 * @param setCookieHeader - The Set-Cookie header value (may contain multiple cookies)
 * @returns Object mapping cookie names to {value, expiresAt}
 */
function parseAllCookies(setCookieHeader: string): Record<string, { value: string; expiresAt?: string }> {
  const cookies: Record<string, { value: string; expiresAt?: string }> = {};

  // Split by comma followed by a cookie name pattern (to handle multiple Set-Cookie values)
  const cookieStrings = setCookieHeader.split(/,(?=[^,]+=)/);
  console.log(`[Lectio API DEBUG] Split Set-Cookie header into ${cookieStrings.length} parts`);

  for (const cookieStr of cookieStrings) {
    console.log(`[Lectio API DEBUG] Parsing cookie string:`, cookieStr.substring(0, 100));

    // Extract cookie name and value
    const match = cookieStr.match(/^([^=]+)=([^;]*)/);
    if (match) {
      const name = match[1].trim();
      const value = match[2].trim();
      const expiresAt = parseExpiration(cookieStr);

      console.log(`[Lectio API DEBUG] Extracted cookie: name="${name}", value="${value}", expiresAt="${expiresAt}"`);

      // Don't include expiresAt if it's undefined (Firestore doesn't allow undefined values)
      if (expiresAt) {
        cookies[name] = { value, expiresAt };
      } else {
        cookies[name] = { value };
      }
    } else {
      console.log(`[Lectio API DEBUG] Failed to match cookie pattern for string:`, cookieStr.substring(0, 100));
    }
  }

  console.log(`[Lectio API DEBUG] Parsed ${Object.keys(cookies).length} cookies total`);
  return cookies;
}

/**
 * Fetches a Lectio page with provided cookies
 * @param schoolId - The Lectio school ID
 * @param path - The path to fetch (e.g., "/SkemaNy.aspx")
 * @param cookies - Object mapping cookie names to values
 * @returns The HTML response and any updated cookies with their expiration dates
 */
export async function fetchLectioWithCookies(
  schoolId: string,
  path: string,
  cookies: Record<string, string>
): Promise<{
  html: string;
  updatedCookies: Record<string, { value: string; expiresAt?: string }>;
}> {
  const url = `https://www.lectio.dk/lectio/${schoolId}${path}`;

  // Build cookie string from all provided cookies
  const cookieParts: string[] = [];
  for (const [name, value] of Object.entries(cookies)) {
    if (value) {
      cookieParts.push(`${name}=${value}`);
    }
  }

  console.log(`[Lectio API] Fetching ${url} with ${Object.keys(cookies).length} cookies`);

  const response = await fetch(url, {
    headers: {
      Cookie: cookieParts.join("; "),
      "User-Agent": "BetterLectio/0.1 (API Client)",
      "Referer": "https://www.lectio.dk",
      "Accept-Encoding": "gzip, deflate, br",
    },
    redirect: "manual", // We'll handle redirects manually to limit to 5
  });

  // Handle redirects manually (max 5 redirects)
  let finalResponse = response;
  let redirectCount = 0;
  const maxRedirects = 5;

  while (
    (finalResponse.status === 301 ||
      finalResponse.status === 302 ||
      finalResponse.status === 303 ||
      finalResponse.status === 307 ||
      finalResponse.status === 308) &&
    redirectCount < maxRedirects
  ) {
    const location = finalResponse.headers.get("location");
    if (!location) break;

    redirectCount++;
    console.log(`[Lectio API] Following redirect ${redirectCount}/${maxRedirects} to ${location}`);

    // Make the redirect URL absolute if it's relative
    const redirectUrl = location.startsWith("http")
      ? location
      : new URL(location, url).toString();

    finalResponse = await fetch(redirectUrl, {
      headers: {
        Cookie: cookieParts.join("; "),
        "User-Agent": "BetterLectio/0.1 (API Client)",
        "Referer": "https://www.lectio.dk",
        "Accept-Encoding": "gzip, deflate, br",
      },
      redirect: "manual",
    });
  }

  if (redirectCount >= maxRedirects) {
    console.warn(`[Lectio API] Max redirects (${maxRedirects}) reached`);
  }

  if (!finalResponse.ok) {
    throw new Error(
      `Failed to fetch Lectio page: ${finalResponse.status} ${finalResponse.statusText}`
    );
  }

  const html = await finalResponse.text();

  // Check for robot detection (only happens when logged out/invalid cookies)
  if (
    html.includes("Af hensyn til sikkerheden") ||
    html.includes("ikke er en robot") ||
    html.includes("captcha")
  ) {
    throw new Error("Robot detection triggered - user is logged out or cookies are invalid");
  }

  // Parse all cookies from Set-Cookie header
  const updatedCookies: Record<string, { value: string; expiresAt?: string }> = {};
  const setCookieHeader = finalResponse.headers.get("set-cookie");

  console.log(`[Lectio API DEBUG] Set-Cookie header present: ${!!setCookieHeader}`);
  if (setCookieHeader) {
    console.log(`[Lectio API DEBUG] Raw Set-Cookie header:`, setCookieHeader);
    const newCookies = parseAllCookies(setCookieHeader);
    console.log(`[Lectio API DEBUG] Parsed cookies from Set-Cookie:`, JSON.stringify(newCookies, null, 2));
    console.log(`[Lectio API DEBUG] Current cookies sent in request:`, JSON.stringify(cookies, null, 2));

    for (const [name, cookieData] of Object.entries(newCookies)) {
      console.log(`[Lectio API DEBUG] Checking cookie "${name}": new="${cookieData.value}" vs old="${cookies[name]}" (equal: ${cookieData.value === cookies[name]})`);

      // Only include if the cookie value changed
      if (cookieData.value !== cookies[name]) {
        updatedCookies[name] = cookieData;
        console.log(`[Lectio API] Cookie "${name}" updated: ${cookies[name]} -> ${cookieData.value}`);
        if (cookieData.expiresAt) {
          console.log(`[Lectio API] Cookie "${name}" expires at: ${cookieData.expiresAt}`);
        }
      } else {
        console.log(`[Lectio API DEBUG] Cookie "${name}" unchanged, skipping`);
      }
    }
  } else {
    console.log(`[Lectio API DEBUG] No Set-Cookie header in response`);
  }

  return {
    html,
    updatedCookies,
  };
}

/**
 * Fetches a Lectio page for a specific student using their stored credentials
 * @param studentId - The student's Lectio ID (elevid)
 * @param path - The path to fetch (e.g., "/SkemaNy.aspx")
 * @param queryParams - Optional query parameters (e.g., { week: "442025" })
 * @returns The HTML response
 */
export async function fetchLectioForStudent(
  studentId: string,
  path: string,
  queryParams?: Record<string, string>
): Promise<{ html: string; schoolId: string }> {
  // Get student credentials from Firebase
  const credDoc = await db.collection("lectioCreds").doc(studentId).get();

  if (!credDoc.exists) {
    throw new Error(`No credentials found for student ${studentId}`);
  }

  const creds = credDoc.data();
  if (!creds) {
    throw new Error(`Invalid credentials for student ${studentId}`);
  }

  const { schoolId, cookies: storedCookies } = creds;

  if (!schoolId) {
    throw new Error(`No schoolId found for student ${studentId}`);
  }

  if (!storedCookies) {
    throw new Error(`No cookies found for student ${studentId}`);
  }

  // Extract cookie values from stored format {cookieName: {value, expiresAt}}
  const cookieValues: Record<string, string> = {};
  for (const [name, cookieData] of Object.entries(storedCookies as Record<string, { value: string; expiresAt?: string }>)) {
    cookieValues[name] = cookieData.value;
  }

  // Build path with query params if provided
  let fullPath = path;
  if (queryParams && Object.keys(queryParams).length > 0) {
    const queryString = new URLSearchParams(queryParams).toString();
    fullPath = `${path}?${queryString}`;
  }

  const result = await fetchLectioWithCookies(schoolId, fullPath, cookieValues);

  console.log(`[Lectio API DEBUG] Stored cookies from Firebase for student ${studentId}:`, JSON.stringify(storedCookies, null, 2));
  console.log(`[Lectio API DEBUG] Updated cookies from Lectio response:`, JSON.stringify(result.updatedCookies, null, 2));

  // Build the complete cookie jar after the request
  const completeCookieJar = { ...storedCookies } as Record<string, { value: string; expiresAt?: string }>;

  // Merge in any updated cookies from the response
  for (const [name, cookieData] of Object.entries(result.updatedCookies)) {
    completeCookieJar[name] = cookieData;
    console.log(`[Lectio API] Cookie "${name}" updated for student ${studentId}: ${JSON.stringify(cookieData)}`);
  }

  console.log(`[Lectio API DEBUG] Complete cookie jar after merge:`, JSON.stringify(completeCookieJar, null, 2));

  // Always sync the complete cookie jar to Firebase after every request
  const cookieJarString = JSON.stringify(completeCookieJar);
  const storedCookieJarString = JSON.stringify(storedCookies);

  console.log(`[Lectio API DEBUG] Stored JSON length: ${storedCookieJarString.length}, Complete JSON length: ${cookieJarString.length}`);
  console.log(`[Lectio API DEBUG] JSONs equal: ${cookieJarString === storedCookieJarString}`);

  if (cookieJarString !== storedCookieJarString) {
    console.log(`[Lectio API] Cookie jar changed! Syncing full cookie jar to Firebase for student ${studentId}`);
    console.log(`[Lectio API DEBUG] Diff - Stored:`, storedCookieJarString.substring(0, 200));
    console.log(`[Lectio API DEBUG] Diff - Complete:`, cookieJarString.substring(0, 200));

    // Build updates object
    const updates: Record<string, any> = { // eslint-disable-line
      cookies: completeCookieJar,
      updatedAt: new Date().toISOString(),
      active: true,
    };

    // Also update top-level autologinkey if it exists in the jar (for scheduler queries)
    if (completeCookieJar.autologinkeyV2) {
      updates.autologinkey = completeCookieJar.autologinkeyV2.value;
      if (completeCookieJar.autologinkeyV2.expiresAt) {
        updates.autologinkeyExpiresAt = completeCookieJar.autologinkeyV2.expiresAt;
      }
    }

    // Remove any undefined values before writing to Firestore
    const cleanedUpdates = removeUndefined(updates);

    await db.collection("lectioCreds").doc(studentId).update(cleanedUpdates);
    console.log(`[Lectio API] Successfully synced cookie jar to Firebase for student ${studentId}`);
  } else {
    console.log(`[Lectio API] Cookie jar unchanged for student ${studentId}, skipping Firebase sync`);
  }

  return { html: result.html, schoolId };
}

/**
 * Check if HTML response is valid (not a robot detection page)
 * @param html - The HTML to check
 * @returns true if valid, false if robot detection
 */
export function isValidLectioResponse(html: string): boolean {
  return !(
    html.includes("Af hensyn til sikkerheden") ||
    html.includes("ikke er en robot") ||
    html.includes("captcha")
  );
}

/**
 * Mark student credentials as inactive in Firebase
 * This should be called when robot detection is triggered (user is logged out)
 * @param studentId - The student's Lectio ID
 */
export async function markCredentialsInactive(studentId: string): Promise<void> {
  console.log(`[Lectio API] Marking credentials as inactive for student ${studentId} due to robot detection (logged out)`);
  await db.collection("lectioCreds").doc(studentId).update({
    active: false,
    updatedAt: new Date().toISOString(),
  });
}
