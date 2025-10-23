import { NextRequest, NextResponse } from 'next/server';
import { load } from 'cheerio';
import { auth } from '@/lib/firebase-admin';

export async function POST(request: NextRequest) {
  try {
    let body;
    try {
      body = await request.json();
    } catch (jsonError) {
      return NextResponse.json(
        { error: 'Invalid JSON in request body' },
        { status: 400 }
      );
    }

    const { schoolId, sessionId, autologinkey } = body;

    if (!schoolId || !sessionId || !autologinkey) {
      return NextResponse.json(
        { error: 'schoolId, sessionId, and autologinkey are required' },
        { status: 400 }
      );
    }

    // Fetch the Lectio page with cookies
    const lectioUrl = `https://www.lectio.dk/lectio/${schoolId}/forside.aspx`;
    const response = await fetch(lectioUrl, {
      headers: {
        Cookie: `ASP.NET_SessionId=${sessionId}; autologinkeyV2=${autologinkey}`,
      },
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: 'Failed to fetch Lectio page' },
        { status: 502 }
      );
    }

    const html = await response.text();
    const $ = load(html);

    // Extract elevid from meta tag
    const metaContent = $('meta[name="msapplication-starturl"]').attr('content');

    if (!metaContent) {
      return NextResponse.json(
        { error: 'Could not find msapplication-starturl meta tag' },
        { status: 500 }
      );
    }

    // Parse elevid from URL (e.g., "/lectio/94/forside.aspx?elevid=72721772841")
    const elevIdMatch = metaContent.match(/elevid=(\d+)/);

    if (!elevIdMatch) {
      return NextResponse.json(
        { error: 'Could not extract elevid from meta tag' },
        { status: 500 }
      );
    }

    const elevId = elevIdMatch[1];

    // Create Firebase custom token with UID format: lectio:schoolId:elevId
    const uid = `lectio:${schoolId}:${elevId}`;
    const customToken = await auth.createCustomToken(uid);

    return NextResponse.json({
      token: customToken,
      uid,
      elevId
    });
  } catch (error) {
    console.error('Error in Lectio auth:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
