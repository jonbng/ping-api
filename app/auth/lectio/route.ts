import { NextRequest, NextResponse } from "next/server";
import { load } from "cheerio";
import { auth, db } from "@/lib/firebase-admin";

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
    const lectioUrl = `https://www.lectio.dk/lectio/${schoolId}/indstillinger/studentIndstillinger.aspx`;
    const response = await fetch(lectioUrl, {
      headers: {
        Cookie: `ASP.NET_SessionId=${sessionId}; autologinkeyV2=${autologinkey}`,
      },
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: "Failed to fetch Lectio page" },
        { status: 502 }
      );
    }

    const html = await response.text();
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
