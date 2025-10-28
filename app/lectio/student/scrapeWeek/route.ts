import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { db } from "@/lib/firebase-admin";
import { Timestamp } from "firebase-admin/firestore";
import * as cheerio from "cheerio";
import { createHash } from "crypto";
import { fetchLectioForStudent, markCredentialsInactive } from "@/lib/lectio";
import { getWeekKey, removeUndefined } from "@/lib/utils";

interface Student {
  studentId: string;
  week?: string; // Optional week in format WWYYYY (e.g., "442025")
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
  // NOTE: This parses times in the server's local timezone, which may cause issues
  // if the server is not in Denmark timezone (Europe/Copenhagen).
  // Lectio times are in Danish local time (CET/CEST).
  // For production, consider using a timezone library or ensure server runs in Europe/Copenhagen timezone.
  try {
    const match = dateTimeStr.match(/(\d{2})\/(\d{2})-(\d{4})\s+(\d{2}):(\d{2})/);
    if (!match) return null;

    const [, day, month, year, hour, minute] = match;
    // Parse as UTC to avoid server timezone issues, then we'll treat it as Denmark time
    // This is a simplification - ideally use a timezone library like date-fns-tz
    const date = new Date(
      Date.UTC(
        parseInt(year),
        parseInt(month) - 1,
        parseInt(day),
        parseInt(hour),
        parseInt(minute)
      )
    );
    return Timestamp.fromDate(date);
  } catch {
    return null;
  }
};

// Helper to convert YYYY-MM-DD date string to week key
const getWeekKeyFromDateString = (dateStr: string): string => {
  // dateStr format: YYYY-MM-DD
  const date = new Date(dateStr);
  return getWeekKey(date);
};

export const POST = verifySignatureAppRouter(async (req: Request) => {
  const startTime = Date.now();

  try {
    const body: Student = await req.json();
    const { studentId } = body;

    if (!studentId) {
      console.error(
        `[Lectio Student Scrape] Missing required field: studentId=${studentId}`
      );
      return new Response("Missing studentId", { status: 400 });
    }

    console.log(
      `[Lectio Student Scrape] Starting scrape for student ${studentId}${body.week ? ` (week ${body.week})` : ""}`
    );

    // Fetch schedule from Lectio using helper
    let html: string;
    let actualSchoolId: string;
    try {
      const queryParams = body.week ? { week: body.week } : undefined;
      const result = await fetchLectioForStudent(studentId, "/SkemaNy.aspx", queryParams);
      html = result.html;
      actualSchoolId = result.schoolId;
      console.log(
        `[Lectio Student Scrape] HTML length: ${html.length} characters`
      );
    } catch (error) {
      // Check if this is a robot detection error (user is logged out)
      const isRobotDetection = error instanceof Error && error.message.includes("Robot detection");

      if (isRobotDetection) {
        // Mark credentials as inactive when robot detection is triggered
        try {
          await markCredentialsInactive(studentId);
          console.log(
            `[Lectio Student Scrape] Marked credentials as inactive for student ${studentId} due to robot detection (logged out)`
          );
        } catch (markError) {
          console.error(
            `[Lectio Student Scrape] Failed to mark credentials as inactive:`,
            markError
          );
        }
      }

      console.error(
        `[Lectio Student Scrape] Failed to fetch schedule:`,
        error
      );
      return new Response(
        `Failed to fetch schedule: ${error instanceof Error ? error.message : "Unknown error"}`,
        { status: isRobotDetection ? 403 : 500 }
      );
    }

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

          const event: ScheduleEvent = removeUndefined({
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
          });

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

      const weekKey = getWeekKeyFromDateString(date);

      const scheduleDay: ScheduleDay = {
        date,
        weekKey,
        schoolId: actualSchoolId,
        studentKey: studentId,
        updatedAt: Timestamp.now(),
        hash,
        events,
      };

      const docRef = db
        .collection("lectio")
        .doc(actualSchoolId)
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
