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
 * Fetches a Lectio page with provided cookies
 * @param schoolId - The Lectio school ID
 * @param path - The path to fetch (e.g., "/SkemaNy.aspx")
 * @param cookies - Object with cookie values { sessionId?, autologinkey?, lectiogsc? }
 * @returns The HTML response and any updated cookies with their expiration dates
 */
export async function fetchLectioWithCookies(
  schoolId: string,
  path: string,
  cookies: {
    sessionId?: string;
    autologinkey?: string;
    lectiogsc?: string;
  }
): Promise<{
  html: string;
  newSessionId?: string;
  newSessionIdExpiresAt?: string;
  newAutologinkey?: string;
  newAutologinkeyExpiresAt?: string;
  newLectiogsc?: string;
  newLectiogscExpiresAt?: string;
}> {
  const url = `https://www.lectio.dk/lectio/${schoolId}${path}`;

  // Build cookie string
  const cookieParts: string[] = [];
  if (cookies.sessionId) {
    cookieParts.push(`ASP.NET_SessionId=${cookies.sessionId}`);
  }
  if (cookies.autologinkey) {
    cookieParts.push(`autologinkeyV2=${cookies.autologinkey}`);
  }
  if (cookies.lectiogsc) {
    cookieParts.push(`lectiogsc=${cookies.lectiogsc}`);
  }

  console.log(`[Lectio API] Fetching ${url}`);

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

  // Check for robot detection
  if (
    html.includes("Af hensyn til sikkerheden") ||
    html.includes("ikke er en robot") ||
    html.includes("captcha")
  ) {
    throw new Error("Robot detection triggered - cannot access Lectio");
  }

  // Check if server sent new cookies
  let newSessionId: string | undefined;
  let newSessionIdExpiresAt: string | undefined;
  let newAutologinkey: string | undefined;
  let newAutologinkeyExpiresAt: string | undefined;
  let newLectiogsc: string | undefined;
  let newLectiogscExpiresAt: string | undefined;

  const setCookieHeader = response.headers.get("set-cookie");
  if (setCookieHeader) {
    // Parse sessionId
    const sessionIdMatch = setCookieHeader.match(/ASP\.NET_SessionId=([^;]+)[^,]*/);
    if (sessionIdMatch && sessionIdMatch[1] !== cookies.sessionId) {
      newSessionId = sessionIdMatch[1];
      newSessionIdExpiresAt = parseExpiration(sessionIdMatch[0]);
      console.log(`[Lectio API] Session ID updated: ${cookies.sessionId} -> ${newSessionId}`);
      if (newSessionIdExpiresAt) {
        console.log(`[Lectio API] Session ID expires at: ${newSessionIdExpiresAt}`);
      }
    }

    // Parse autologinkey
    const autologinkeyMatch = setCookieHeader.match(/autologinkeyV2=([^;]+)[^,]*/);
    if (autologinkeyMatch && autologinkeyMatch[1] !== cookies.autologinkey) {
      newAutologinkey = autologinkeyMatch[1];
      newAutologinkeyExpiresAt = parseExpiration(autologinkeyMatch[0]);
      console.log(`[Lectio API] Autologinkey updated: ${cookies.autologinkey} -> ${newAutologinkey}`);
      if (newAutologinkeyExpiresAt) {
        console.log(`[Lectio API] Autologinkey expires at: ${newAutologinkeyExpiresAt}`);
      }
    }

    // Parse lectiogsc
    const lectiogscMatch = setCookieHeader.match(/lectiogsc=([^;]+)[^,]*/);
    if (lectiogscMatch && lectiogscMatch[1] !== cookies.lectiogsc) {
      newLectiogsc = lectiogscMatch[1];
      newLectiogscExpiresAt = parseExpiration(lectiogscMatch[0]);
      console.log(`[Lectio API] Lectiogsc updated: ${cookies.lectiogsc} -> ${newLectiogsc}`);
      if (newLectiogscExpiresAt) {
        console.log(`[Lectio API] Lectiogsc expires at: ${newLectiogscExpiresAt}`);
      }
    }
  }

  return {
    html,
    newSessionId,
    newSessionIdExpiresAt,
    newAutologinkey,
    newAutologinkeyExpiresAt,
    newLectiogsc,
    newLectiogscExpiresAt,
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

  const { schoolId, autologinkey, sessionId, lectiogsc } = creds;

  if (!schoolId) {
    throw new Error(`No schoolId found for student ${studentId}`);
  }

  if (!autologinkey) {
    throw new Error(`No autologinkey found for student ${studentId}`);
  }

  // Build path with query params if provided
  let fullPath = path;
  if (queryParams && Object.keys(queryParams).length > 0) {
    const queryString = new URLSearchParams(queryParams).toString();
    fullPath = `${path}?${queryString}`;
  }

  const result = await fetchLectioWithCookies(schoolId, fullPath, {
    sessionId,
    autologinkey,
    lectiogsc,
  });

  // Update cookies in Firebase if any changed
  if (result.newSessionId || result.newAutologinkey || result.newLectiogsc) {
    const updates: Record<string, string> = {
      updatedAt: new Date().toISOString(),
    };

    if (result.newSessionId) {
      updates.sessionId = result.newSessionId;
      console.log(`[Lectio API] Updating session ID for student ${studentId} in Firebase`);
      if (result.newSessionIdExpiresAt) {
        updates.sessionIdExpiresAt = result.newSessionIdExpiresAt;
      }
    }

    if (result.newAutologinkey) {
      updates.autologinkey = result.newAutologinkey;
      console.log(`[Lectio API] Updating autologinkey for student ${studentId} in Firebase`);
      if (result.newAutologinkeyExpiresAt) {
        updates.autologinkeyExpiresAt = result.newAutologinkeyExpiresAt;
      }
    }

    if (result.newLectiogsc) {
      updates.lectiogsc = result.newLectiogsc;
      console.log(`[Lectio API] Updating lectiogsc for student ${studentId} in Firebase`);
      if (result.newLectiogscExpiresAt) {
        updates.lectiogscExpiresAt = result.newLectiogscExpiresAt;
      }
    }

    await db.collection("lectioCreds").doc(studentId).update(updates);
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
