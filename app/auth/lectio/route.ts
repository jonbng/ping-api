import { NextRequest, NextResponse } from "next/server";
import { load } from "cheerio";
import { auth, db } from "@/lib/firebase-admin";
import { Client } from "@upstash/qstash";
import { fetchLectioWithCookies } from "@/lib/lectio";
import { getWeekKey } from "@/lib/utils";

export async function POST(request: NextRequest) {
  const requestId = Math.random().toString(36).substring(7);
  console.log(`[Lectio Auth ${requestId}] Starting authentication request`);

  try {
    let body;
    try {
      body = await request.json();
      console.log(`[Lectio Auth ${requestId}] Parsed request body`);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (jsonError) {
      console.log(`[Lectio Auth ${requestId}] Failed to parse JSON in request body`);
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

    console.log(`[Lectio Auth ${requestId}] Received credentials for school ${schoolId}`);
    console.log(`[Lectio Auth ${requestId}] Has lectiogsc cookie: ${!!lectiogsc}`);

    if (
      !schoolId ||
      !sessionId ||
      !autologinkey ||
      !autologinkeyExpiresAt ||
      !sessionIdExpiresAt
    ) {
      console.log(`[Lectio Auth ${requestId}] Missing required fields`);
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

    console.log(`[Lectio Auth ${requestId}] Built initial cookie jar with ${Object.keys(initialCookies).length} cookies`);

    // Fetch the Lectio page with cookies
    let html: string;
    const cookieJar: Record<string, { value: string; expiresAt?: string }> = {};
    try {
      console.log(`[Lectio Auth ${requestId}] Fetching student settings page from Lectio...`);
      const result = await fetchLectioWithCookies(
        schoolId,
        "/indstillinger/studentIndstillinger.aspx",
        initialCookies
      );
      html = result.html;
      console.log(`[Lectio Auth ${requestId}] Successfully fetched Lectio page (${html.length} characters)`);
      console.log(`[Lectio Auth ${requestId}] Received ${Object.keys(result.updatedCookies).length} updated cookies from Lectio`);

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
          `[Lectio Auth ${requestId}] Cookie "${name}" updated during auth: ${initialCookies[name]} -> ${cookieData.value}`
        );
      }
    } catch (error) {
      console.error(`[Lectio Auth ${requestId}] Failed to fetch Lectio page:`, error);
      console.error(`[Lectio Auth ${requestId}] Error details:`, {
        message: error instanceof Error ? error.message : "Unknown error",
        schoolId,
        hasSessionId: !!sessionId,
        hasAutologinkey: !!autologinkey,
        hasLectiogsc: !!lectiogsc,
      });
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

    console.log(`[Lectio Auth ${requestId}] Parsing HTML to extract student information...`);
    const $ = load(html);

    // Extract elevid from meta tag
    const metaContent = $('meta[name="msapplication-starturl"]').attr(
      "content"
    );

    if (!metaContent) {
      console.error(`[Lectio Auth ${requestId}] Could not find msapplication-starturl meta tag in HTML`);
      console.error(`[Lectio Auth ${requestId}] Full HTML response:`, html);
      return NextResponse.json(
        { error: "Could not find msapplication-starturl meta tag" },
        { status: 500 }
      );
    }

    console.log(`[Lectio Auth ${requestId}] Found meta tag with content: ${metaContent}`);

    // Parse elevid from URL (e.g., "/lectio/94/forside.aspx?elevid=72721772841")
    const elevIdMatch = metaContent.match(/elevid=(\d+)/);

    if (!elevIdMatch) {
      console.error(`[Lectio Auth ${requestId}] Could not extract elevid from meta tag content: ${metaContent}`);
      console.error(`[Lectio Auth ${requestId}] Full HTML response:`, html);
      return NextResponse.json(
        { error: "Could not extract elevid from meta tag" },
        { status: 500 }
      );
    }

    const elevId = elevIdMatch[1];
    console.log(`[Lectio Auth ${requestId}] Extracted student ID: ${elevId}`);

    // Parse Fornavn and Efternavn from the page
    console.log(`[Lectio Auth ${requestId}] Extracting student name from page...`);
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
      console.error(`[Lectio Auth ${requestId}] Could not extract name from Lectio page`);
      console.error(`[Lectio Auth ${requestId}] Found firstName: "${firstName}", lastName: "${lastName}"`);
      console.error(`[Lectio Auth ${requestId}] Full HTML response:`, html);
      return NextResponse.json(
        { error: "Could not extract name from Lectio page" },
        { status: 500 }
      );
    }

    console.log(`[Lectio Auth ${requestId}] Extracted student name: ${firstName} ${lastName}`);

    // Store credentials in Firestore with the complete cookie jar
    console.log(`[Lectio Auth ${requestId}] Preparing to store credentials in Firestore...`);
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

    console.log(`[Lectio Auth ${requestId}] Storing ${Object.keys(cookieJar).length} cookies in cookie jar`);

    await db.collection("lectioCreds").doc(elevId).set(
      credentialsData,
      {
        merge: true,
      }
    );

    console.log(`[Lectio Auth ${requestId}] Successfully stored credentials for student ${elevId}`);

    // Create Firebase custom token with UID format: lectio:schoolId:elevId
    const uid = `lectio:${schoolId}:${elevId}`;
    console.log(`[Lectio Auth ${requestId}] Creating Firebase custom token for UID: ${uid}`);
    const customToken = await auth.createCustomToken(uid);
    console.log(`[Lectio Auth ${requestId}] Successfully created custom token`);

    // Store student data in the proper subcollection path
    console.log(`[Lectio Auth ${requestId}] Storing student data in lectio/${schoolId}/students/${elevId}`);
    await db
      .collection("lectio")
      .doc(schoolId)
      .collection("students")
      .doc(elevId)
      .set(
        {
          firebaseUid: uid,
          lectioId: elevId,
          schoolId: schoolId,
        },
        {
          merge: true,
        }
      );
    console.log(`[Lectio Auth ${requestId}] Successfully stored student data`);

    // Trigger immediate schedule scrape for this student
    console.log(`[Lectio Auth ${requestId}] Triggering immediate schedule scrape for student ${elevId}...`);
    try {
      const qstashClient = new Client({
        token: process.env.QSTASH_TOKEN!,
        baseUrl: process.env.QSTASH_URL || "https://qstash.upstash.io",
      });
      const baseUrl = process.env.NEXT_PUBLIC_API_URL || "https://api.joinping.dk";

      console.log(`[Lectio Auth ${requestId}] Publishing scrape job for current week to ${baseUrl}/lectio/student/scrapeWeek`);
      await qstashClient.publishJSON({
        url: `${baseUrl}/lectio/student/scrapeWeek`,
        body: {
          studentId: elevId,
        },
      });

      const nextWeek = new Date(new Date().getTime() + 1000 * 60 * 60 * 24 * 7);
      const nextWeekKey = getWeekKey(nextWeek);
      console.log(`[Lectio Auth ${requestId}] Publishing scrape job for next week (${nextWeekKey})`);
      await qstashClient.publishJSON({
        url: `${baseUrl}/lectio/student/scrapeWeek`,
        body: {
          studentId: elevId,
          week: nextWeekKey,
        },
      });
      console.log(
        `[Lectio Auth ${requestId}] Successfully triggered scrape jobs for student ${elevId} at school ${schoolId}`
      );
    } catch (qstashError) {
      // Don't fail auth if scrape scheduling fails - but store failure for retry
      console.error(`[Lectio Auth ${requestId}] Failed to trigger scrape job:`, qstashError);
      console.error(`[Lectio Auth ${requestId}] QStash error details:`, {
        message: qstashError instanceof Error ? qstashError.message : "Unknown error",
        studentId: elevId,
        schoolId,
      });

      // Store scrape failure so it can be retried later
      try {
        await db.collection("lectioCreds").doc(elevId).update({
          lastScrapeError: new Date().toISOString(),
          lastScrapeErrorMessage: qstashError instanceof Error ? qstashError.message : "Unknown error",
        });
        console.log(`[Lectio Auth ${requestId}] Stored scrape error for later retry`);
      } catch (updateError) {
        console.error(`[Lectio Auth ${requestId}] Failed to store scrape error:`, updateError);
      }
    }

    console.log(`[Lectio Auth ${requestId}] Authentication successful for ${firstName} ${lastName} (${elevId})`);
    console.log(`[Lectio Auth ${requestId}] Returning response with custom token and student details`);

    return NextResponse.json({
      customToken: customToken,
      firebaseUid: uid,
      lectioId: elevId,
      name: `${firstName} ${lastName}`,
    });
  } catch (error) {
    console.error(`[Lectio Auth ${requestId}] Unhandled error in Lectio auth:`, error);
    console.error(`[Lectio Auth ${requestId}] Error stack:`, error instanceof Error ? error.stack : "No stack trace");
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
