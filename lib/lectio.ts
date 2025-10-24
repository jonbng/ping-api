import { db } from "@/lib/firebase-admin";

/**
 * Fetches a Lectio page with provided cookies
 * @param schoolId - The Lectio school ID
 * @param path - The path to fetch (e.g., "/SkemaNy.aspx")
 * @param cookies - Object with cookie values { sessionId?, autologinkey? }
 * @returns The HTML response
 */
export async function fetchLectioWithCookies(
  schoolId: string,
  path: string,
  cookies: {
    sessionId?: string;
    autologinkey?: string;
  }
): Promise<string> {
  const url = `https://www.lectio.dk/lectio/${schoolId}${path}`;

  // Build cookie string
  const cookieParts: string[] = [];
  if (cookies.sessionId) {
    cookieParts.push(`ASP.NET_SessionId=${cookies.sessionId}`);
  }
  if (cookies.autologinkey) {
    cookieParts.push(`autologinkeyV2=${cookies.autologinkey}`);
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

  return html;
}

/**
 * Fetches a Lectio page for a specific student using their stored credentials
 * @param studentId - The student's Lectio ID (elevid)
 * @param path - The path to fetch (e.g., "/SkemaNy.aspx")
 * @returns The HTML response
 */
export async function fetchLectioForStudent(
  studentId: string,
  path: string
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

  const { schoolId, autologinkey, sessionId } = creds;

  if (!schoolId) {
    throw new Error(`No schoolId found for student ${studentId}`);
  }

  if (!autologinkey) {
    throw new Error(`No autologinkey found for student ${studentId}`);
  }

  const html = await fetchLectioWithCookies(schoolId, path, {
    sessionId,
    autologinkey,
  });

  return { html, schoolId };
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
