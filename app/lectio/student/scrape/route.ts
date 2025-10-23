import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { db } from "@/lib/firebase-admin";
import { Timestamp } from "firebase-admin/firestore";
import * as cheerio from "cheerio";
import { createHash } from "crypto";

interface Student {
  studentId: string;
  schoolId: string;
}

type EventStatus = "OK" | "CANCELLED" | "MOVED";

interface ScheduleEvent {
  id: string;
  startAt: Timestamp;
  endAt: Timestamp;
  subject: string;
  room?: string;
  teacher?: string;
  classKey: string;
  status: EventStatus;
  lastChangedAt?: Timestamp;
  // Additional fields
  absId: string;
  time: string;
  hold?: string;
  note?: string;
  homework?: string;
  title?: string;
}

interface ScheduleDay {
  date: string; // YYYY-MM-DD
  weekKey: string; // YYYY-WW
  schoolId: string;
  studentKey: string;
  updatedAt: Timestamp;
  hash: string;
  events: ScheduleEvent[];
}

// Helper to parse Danish date/time to Timestamp
const parseDateTime = (dateTimeStr: string): Timestamp | null => {
  // Format: "20/10-2025 08:10 til 09:50" or "20/10-2025 Hele dagen"
  try {
    const match = dateTimeStr.match(/(\d{2})\/(\d{2})-(\d{4})\s+(\d{2}):(\d{2})/);
    if (!match) return null;

    const [, day, month, year, hour, minute] = match;
    const date = new Date(
      parseInt(year),
      parseInt(month) - 1,
      parseInt(day),
      parseInt(hour),
      parseInt(minute)
    );
    return Timestamp.fromDate(date);
  } catch {
    return null;
  }
};

// Helper to get week key (YYYY-WW)
const getWeekKey = (dateStr: string): string => {
  // dateStr format: YYYY-MM-DD
  const date = new Date(dateStr);
  const year = date.getFullYear();
  const startOfYear = new Date(year, 0, 1);
  const diff = date.getTime() - startOfYear.getTime();
  const oneWeek = 1000 * 60 * 60 * 24 * 7;
  const week = Math.ceil(diff / oneWeek);
  return `${year}-${week.toString().padStart(2, "0")}`;
};

export const POST = verifySignatureAppRouter(async (req: Request) => {
  const startTime = Date.now();
  console.log("[Lectio Student Scrape] Endpoint called");

  try {
    console.log("[Lectio Student Scrape] Parsing request body...");
    let body: Student;
    try {
      const rawBody = await req.json();
      console.log(
        `[Lectio Student Scrape] Raw body:`,
        JSON.stringify(rawBody)
      );
      console.log(`[Lectio Student Scrape] Raw body type:`, typeof rawBody);

      // Handle double-encoded JSON from QStash
      if (typeof rawBody === "string") {
        body = JSON.parse(rawBody);
        console.log(
          `[Lectio Student Scrape] Body after double parse:`,
          JSON.stringify(body)
        );
      } else {
        body = rawBody;
      }
    } catch (parseError) {
      console.error(
        `[Lectio Student Scrape] Failed to parse JSON body:`,
        parseError
      );
      return new Response("Invalid JSON body", { status: 400 });
    }

    const { studentId, schoolId } = body;

    if (!studentId || !schoolId) {
      console.error(
        `[Lectio Student Scrape] Missing required fields: studentId=${studentId}, schoolId=${schoolId}`
      );
      return new Response("Missing studentId or schoolId", { status: 400 });
    }

    console.log(
      `[Lectio Student Scrape] Starting scrape for student ${studentId} at school ${schoolId}`
    );

    // Get autologinkey from Firebase
    const credDoc = await db.collection("lectioCreds").doc(studentId).get();

    if (!credDoc.exists) {
      console.error(
        `[Lectio Student Scrape] No credentials found for student ${studentId}`
      );
      return new Response("Student credentials not found", { status: 404 });
    }

    const creds = credDoc.data();
    const autologinkey = creds?.autologinkey;

    if (!autologinkey) {
      console.error(
        `[Lectio Student Scrape] No autologinkey found for student ${studentId}`
      );
      return new Response("Student autologinkey not found", { status: 404 });
    }

    // Fetch schedule from Lectio
    const lectioUrl = `https://www.lectio.dk/lectio/${schoolId}/SkemaNy.aspx`;
    console.log(`[Lectio Student Scrape] Fetching schedule from ${lectioUrl}`);

    const response = await fetch(lectioUrl, {
      headers: {
        Cookie: `autologinkeyV2=${autologinkey}`,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    if (!response.ok) {
      console.error(
        `[Lectio Student Scrape] Failed to fetch schedule: ${response.status}`
      );
      return new Response("Failed to fetch schedule", { status: 500 });
    }

    const html = await response.text();
    console.log(
      `[Lectio Student Scrape] HTML length: ${html.length} characters`
    );
    const $ = cheerio.load(html);

    // Parse schedule events grouped by date
    const eventsByDate: Record<string, ScheduleEvent[]> = {};

    // Find all td elements with data-date attribute (these are the day columns)
    const dateCells = $("td[data-date]");
    console.log(
      `[Lectio Student Scrape] Found ${dateCells.length} date cells`
    );

    $("td[data-date]").each((_, dateCell) => {
      const date = $(dateCell).attr("data-date");
      if (!date) return;

      // Find all schedule events within this day
      $(dateCell)
        .find("a.s2skemabrik[data-brikid]")
        .each((_, eventEl) => {
          const $event = $(eventEl);
          const tooltip = $event.attr("data-tooltip");
          const absId = $event.attr("data-brikid")?.replace("ABS", "") || "";

          if (!tooltip) return;

          // Parse tooltip content
          const lines = tooltip.split("\n").map((l) => l.trim());

          // Determine status
          let status: EventStatus = "OK";
          let lastChangedAt: Timestamp | undefined;
          if (lines[0] === "Ændret!") {
            status = "MOVED";
            lastChangedAt = Timestamp.now();
            lines.shift(); // Remove status line
          } else if (lines[0] === "Aflyst!") {
            status = "CANCELLED";
            lastChangedAt = Timestamp.now();
            lines.shift(); // Remove status line
          }

          // Parse event details
          let timeStr = "";
          let hold = "";
          let teacher: string | undefined;
          let room: string | undefined;
          let note: string | undefined;
          let homework: string | undefined;
          let title: string | undefined;

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Check if it's the date/time line (contains "til")
            if (line.includes(" til ") || line.includes("Hele dagen")) {
              timeStr = line;
            }
            // Check for title (lines that don't match common patterns)
            else if (
              !line.startsWith("Hold:") &&
              !line.startsWith("Lærer:") &&
              !line.startsWith("Lærere:") &&
              !line.startsWith("Lokale:") &&
              !line.startsWith("Note:") &&
              !line.startsWith("Lektier:") &&
              !line.startsWith("Elever:") &&
              line !== "" &&
              i > 0 &&
              !title
            ) {
              title = line;
            }
            // Hold (class/group)
            else if (line.startsWith("Hold:")) {
              hold = line.replace("Hold:", "").trim();
            }
            // Teacher
            else if (line.startsWith("Lærer:") || line.startsWith("Lærere:")) {
              teacher = line
                .replace("Lærer:", "")
                .replace("Lærere:", "")
                .trim();
            }
            // Room
            else if (line.startsWith("Lokale:")) {
              room = line.replace("Lokale:", "").trim();
            }
            // Note
            else if (line.startsWith("Note:")) {
              // Collect all following non-empty lines until we hit Lektier or end
              const noteLines = [line.replace("Note:", "").trim()];
              for (let j = i + 1; j < lines.length; j++) {
                if (lines[j].startsWith("Lektier:") || lines[j] === "") break;
                noteLines.push(lines[j]);
              }
              note = noteLines.join(" ").trim();
            }
            // Homework
            else if (line.startsWith("Lektier:")) {
              // Collect remaining lines as homework
              const homeworkLines = [line.replace("Lektier:", "").trim()];
              for (let j = i + 1; j < lines.length; j++) {
                if (lines[j] !== "") homeworkLines.push(lines[j]);
              }
              homework = homeworkLines.join(" ").trim();
            }
          }

          // Parse start and end times
          const startAt = parseDateTime(timeStr);
          let endAt: Timestamp;

          if (!startAt) {
            // If we can't parse the time, skip this event
            return;
          }

          // Parse end time from "til" part
          const endMatch = timeStr.match(/til\s+(\d{2}):(\d{2})/);
          if (endMatch) {
            const [, hour, minute] = endMatch;
            const startDate = startAt.toDate();
            const endDate = new Date(startDate);
            endDate.setHours(parseInt(hour), parseInt(minute));
            endAt = Timestamp.fromDate(endDate);
          } else {
            // Default to 2 hours later
            const endDate = new Date(startAt.toDate());
            endDate.setHours(endDate.getHours() + 2);
            endAt = Timestamp.fromDate(endDate);
          }

          const event: ScheduleEvent = {
            id: absId,
            startAt,
            endAt,
            subject: hold || title || "Ukendt",
            room,
            teacher,
            classKey: hold || "unknown",
            status,
            lastChangedAt,
            // Additional fields
            absId,
            time: timeStr,
            hold,
            note,
            homework,
            title,
          };

          // Add event to the date's events
          if (!eventsByDate[date]) {
            eventsByDate[date] = [];
          }
          eventsByDate[date].push(event);
        });
    });

    // Write to Firebase
    const batch = db.batch();
    let totalEvents = 0;

    for (const [date, events] of Object.entries(eventsByDate)) {
      if (events.length === 0) continue;

      // Calculate hash of events
      const hash = createHash("sha256")
        .update(JSON.stringify(events))
        .digest("hex");

      const weekKey = getWeekKey(date);

      const scheduleDay: ScheduleDay = {
        date,
        weekKey,
        schoolId,
        studentKey: studentId,
        updatedAt: Timestamp.now(),
        hash,
        events,
      };

      const docRef = db
        .collection("lectio")
        .doc(schoolId)
        .collection("students")
        .doc(studentId)
        .collection("schedules")
        .doc(date);

      batch.set(docRef, scheduleDay);

      totalEvents += events.length;
    }

    await batch.commit();

    const duration = Date.now() - startTime;
    console.log(
      `[Lectio Student Scrape] ✓ Successfully scraped ${totalEvents} events across ${Object.keys(eventsByDate).length} days for student ${studentId} in ${duration}ms`
    );

    return new Response(
      `Successfully scraped ${totalEvents} events across ${Object.keys(eventsByDate).length} days`,
      { status: 200 }
    );
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(
      `[Lectio Student Scrape] ✗ Failed after ${duration}ms:`,
      error
    );
    console.error(
      `[Lectio Student Scrape] Error stack:`,
      error instanceof Error ? error.stack : "No stack trace"
    );
    return new Response(
      `Failed to scrape schedule: ${error instanceof Error ? error.message : "Unknown error"}`,
      { status: 500 }
    );
  }
});
