import { NextRequest, NextResponse } from "next/server";
import { load } from "cheerio";
import { auth, db } from "@/lib/firebase-admin";
import { Client } from "@upstash/qstash";
import { fetchLectioWithCookies } from "@/lib/lectio";

const getWeekKey = (date: Date): string => {
  // response format format: WWYYYY
  const week = Math.ceil(date.getTime() / (1000 * 60 * 60 * 24 * 7));
  const year = date.getFullYear();
  return `${week.toString().padStart(2, "0")}${year.toString()}`;
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

    // Fetch the Lectio page with cookies
    let html: string;
    try {
      html = await fetchLectioWithCookies(
        schoolId,
        "/indstillinger/studentIndstillinger.aspx",
        {
          sessionId,
          autologinkey,
        }
      );
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

    $("tr").each((i, elem) => {
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

    // Store credentials in Firestore
    await db.collection("lectioCreds").doc(elevId).set(
      {
        schoolId,
        studentId: elevId,
        sessionId,
        autologinkey,
        autologinkeyExpiresAt,
        sessionIdExpiresAt,
        firstName,
        lastName,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
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
