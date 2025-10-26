import { db } from "@/lib/firebase-admin";

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

  for (const cookieStr of cookieStrings) {
    // Extract cookie name and value
    const match = cookieStr.match(/^([^=]+)=([^;]*)/);
    if (match) {
      const name = match[1].trim();
      const value = match[2].trim();
      const expiresAt = parseExpiration(cookieStr);

      cookies[name] = { value, expiresAt };
    }
  }

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
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch Lectio page: ${response.status} ${response.statusText}`
    );
  }

  const html = await response.text();

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
  const setCookieHeader = response.headers.get("set-cookie");

  if (setCookieHeader) {
    const newCookies = parseAllCookies(setCookieHeader);

    for (const [name, cookieData] of Object.entries(newCookies)) {
      // Only include if the cookie value changed
      if (cookieData.value !== cookies[name]) {
        updatedCookies[name] = cookieData;
        console.log(`[Lectio API] Cookie "${name}" updated: ${cookies[name]} -> ${cookieData.value}`);
        if (cookieData.expiresAt) {
          console.log(`[Lectio API] Cookie "${name}" expires at: ${cookieData.expiresAt}`);
        }
      }
    }
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

  // Update cookies in Firebase if any changed
  if (Object.keys(result.updatedCookies).length > 0) {
    // Merge updated cookies with existing ones
    const mergedCookies = { ...storedCookies };
    for (const [name, cookieData] of Object.entries(result.updatedCookies)) {
      mergedCookies[name] = cookieData;
      console.log(`[Lectio API] Updating cookie "${name}" for student ${studentId} in Firebase`);
    }

    await db.collection("lectioCreds").doc(studentId).update({
      cookies: mergedCookies,
      updatedAt: new Date().toISOString(),
      active: true, // Mark as active when cookies are successfully updated
    });
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
