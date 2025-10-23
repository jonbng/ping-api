import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { value1, value2 } = body;

    if (!value1 || !value2) {
      return NextResponse.json(
        { error: 'Both value1 and value2 are required' },
        { status: 400 }
      );
    }

    const combined = value1 + value2;

    return NextResponse.json({ result: combined });
  } catch (error) {
    return NextResponse.json(
      { error: 'Invalid request body' },
      { status: 400 }
    );
  }
}
