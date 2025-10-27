import { NextRequest, NextResponse } from "next/server";
import { load } from "cheerio";
import { auth, db } from "@/lib/firebase-admin";
import { Client } from "@upstash/qstash";
import { fetchLectioWithCookies } from "@/lib/lectio";

const getWeekKey = (date: Date): string => {
  // response format format: WWYYYY (e.g., 452025 for week 45 of 2025)
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

export async function POST(request: NextRequest) {
  try {
    let body;
    try {
      body = await request.json();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (jsonError) {
      return NextResponse.json(
        { error: "Invalid JSON in request body" },
        { status: 400 }
      );
    }

    const {
      schoolId,
      sessionId,
      autologinkey,
      autologinkeyExpiresAt,
      sessionIdExpiresAt,
      lectiogsc,
      lectiogscExpiresAt,
    } = body;

    if (
      !schoolId ||
      !sessionId ||
      !autologinkey ||
      !autologinkeyExpiresAt ||
      !sessionIdExpiresAt
    ) {
      return NextResponse.json(
        {
          error:
            "schoolId, sessionId, autologinkey, autologinkeyExpiresAt, and sessionIdExpiresAt are required",
        },
        { status: 400 }
      );
    }

    // Build initial cookie jar with all provided cookies
    const initialCookies: Record<string, string> = {
      "ASP.NET_SessionId": sessionId,
      "autologinkeyV2": autologinkey,
    };

    if (lectiogsc) {
      initialCookies.lectiogsc = lectiogsc;
    }

    // Fetch the Lectio page with cookies
    let html: string;
    const cookieJar: Record<string, { value: string; expiresAt?: string }> = {};
    try {
      const result = await fetchLectioWithCookies(
        schoolId,
        "/indstillinger/studentIndstillinger.aspx",
        initialCookies
      );
      html = result.html;

      // Build initial cookie jar with provided cookies and their expiration dates
      // Don't include expiresAt if undefined (Firestore doesn't allow undefined values)
      cookieJar["ASP.NET_SessionId"] = { value: sessionId };
      if (sessionIdExpiresAt) {
        cookieJar["ASP.NET_SessionId"].expiresAt = sessionIdExpiresAt;
      }

      cookieJar["autologinkeyV2"] = { value: autologinkey };
      if (autologinkeyExpiresAt) {
        cookieJar["autologinkeyV2"].expiresAt = autologinkeyExpiresAt;
      }

      if (lectiogsc) {
        cookieJar.lectiogsc = { value: lectiogsc };
        if (lectiogscExpiresAt) {
          cookieJar.lectiogsc.expiresAt = lectiogscExpiresAt;
        }
      }

      // Merge in any updated cookies from the response
      for (const [name, cookieData] of Object.entries(result.updatedCookies)) {
        cookieJar[name] = cookieData;
        console.log(
          `[Lectio Auth] Cookie "${name}" updated during auth: ${initialCookies[name]} -> ${cookieData.value}`
        );
      }
    } catch (error) {
      return NextResponse.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Failed to fetch Lectio page",
        },
        { status: 502 }
      );
    }

    const $ = load(html);

    // Extract elevid from meta tag
    const metaContent = $('meta[name="msapplication-starturl"]').attr(
      "content"
    );

    if (!metaContent) {
      return NextResponse.json(
        { error: "Could not find msapplication-starturl meta tag" },
        { status: 500 }
      );
    }

    // Parse elevid from URL (e.g., "/lectio/94/forside.aspx?elevid=72721772841")
    const elevIdMatch = metaContent.match(/elevid=(\d+)/);

    if (!elevIdMatch) {
      return NextResponse.json(
        { error: "Could not extract elevid from meta tag" },
        { status: 500 }
      );
    }

    const elevId = elevIdMatch[1];

    // Parse Fornavn and Efternavn from the page
    let firstName = "";
    let lastName = "";

    $("tr").each((_, elem) => {
      const th = $(elem).find("th").text().trim();
      if (th === "Fornavn:") {
        firstName = $(elem).find("td").text().trim();
      } else if (th === "Efternavn:") {
        lastName = $(elem).find("td").text().trim();
      }
    });

    if (!firstName || !lastName) {
      return NextResponse.json(
        { error: "Could not extract name from Lectio page" },
        { status: 500 }
      );
    }

    // Store credentials in Firestore with the complete cookie jar
    const credentialsData: Record<string, any> = { // eslint-disable-line
      schoolId,
      studentId: elevId,
      cookies: cookieJar, // Store all cookies with expiration dates
      firstName,
      lastName,
      active: true, // Set to true when successfully authenticated
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Keep autologinkey at top level for backward compatibility and scheduler queries
    if (cookieJar.autologinkeyV2) {
      credentialsData.autologinkey = cookieJar.autologinkeyV2.value;
      if (cookieJar.autologinkeyV2.expiresAt) {
        credentialsData.autologinkeyExpiresAt = cookieJar.autologinkeyV2.expiresAt;
      }
    }

    await db.collection("lectioCreds").doc(elevId).set(
      credentialsData,
      {
        merge: true,
      }
    );

    // Create Firebase custom token with UID format: lectio:schoolId:elevId
    const uid = `lectio:${schoolId}:${elevId}`;
    const customToken = await auth.createCustomToken(uid);

    await db.collection(`lectio/${schoolId}/students/`).doc(elevId).set(
      {
        firebaseUid: uid,
        lectioId: elevId,
        schoolId: schoolId,
      },
      {
        merge: true,
      }
    );

    // Trigger immediate schedule scrape for this student
    try {
      const qstashClient = new Client();
      await qstashClient.publishJSON({
        url: "https://api.joinping.dk/lectio/student/scrapeWeek",
        body: {
          studentId: elevId,
        },
      });

      const nextWeek = new Date(new Date().getTime() + 1000 * 60 * 60 * 24 * 7);
      await qstashClient.publishJSON({
        url: "https://api.joinping.dk/lectio/student/scrapeWeek",
        body: {
          studentId: elevId,
          week: getWeekKey(nextWeek),
        },
      });
      console.log(
        `[Lectio Auth] Triggered scrape job for student ${elevId} at school ${schoolId}`
      );
    } catch (qstashError) {
      // Don't fail auth if scrape scheduling fails
      console.error(`[Lectio Auth] Failed to trigger scrape job:`, qstashError);
    }

    return NextResponse.json({
      customToken: customToken,
      firebaseUid: uid,
      lectioId: elevId,
      name: `${firstName} ${lastName}`,
    });
  } catch (error) {
    console.error("Error in Lectio auth:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
