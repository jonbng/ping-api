import { readFileSync } from "fs";
import { join } from "path";
import * as cheerio from "cheerio";

interface ScheduleEvent {
  absId: string;
  time: string;
  hold?: string;
  teacher?: string;
  room?: string;
  note?: string;
  homework?: string;
  status: "OK" | "CANCELLED" | "MOVED";
  title?: string;
}

// Read the HTML file
const htmlPath = join(__dirname, "..", "skemany.html");
const html = readFileSync(htmlPath, "utf-8");

console.log(`HTML file size: ${html.length} characters\n`);

const $ = cheerio.load(html);

// Parse schedule events grouped by date
const eventsByDate: Record<string, ScheduleEvent[]> = {};

// Find all td elements with data-date attribute (these are the day columns)
const dateCells = $("td[data-date]");
console.log(`Found ${dateCells.length} date cells\n`);

$("td[data-date]").each((_, dateCell) => {
  const date = $(dateCell).attr("data-date");
  if (!date) return;

  console.log(`\n=== Processing date: ${date} ===`);

  // Find all schedule events within this day
  const events = $(dateCell).find("a.s2skemabrik[data-brikid]");
  console.log(`  Found ${events.length} events for ${date}`);

  $(dateCell)
    .find("a.s2skemabrik[data-brikid]")
    .each((eventIdx, eventEl) => {
      const $event = $(eventEl);
      const tooltip = $event.attr("data-tooltip");
      const absId = $event.attr("data-brikid")?.replace("ABS", "") || "";

      if (!tooltip) {
        console.log(`  Event ${eventIdx + 1}: No tooltip found`);
        return;
      }

      console.log(`\n  Event ${eventIdx + 1} (absId: ${absId}):`);
      console.log(`  Tooltip:\n${tooltip}`);

      // Parse tooltip content
      const lines = tooltip.split("\n").map((l) => l.trim());

      // Determine status
      let status: "OK" | "CANCELLED" | "MOVED" = "OK";
      if (lines[0] === "Ændret!") {
        status = "MOVED";
        lines.shift(); // Remove status line
      } else if (lines[0] === "Aflyst!") {
        status = "CANCELLED";
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

      const event: ScheduleEvent = {
        absId,
        time: timeStr,
        hold,
        teacher,
        room,
        note,
        homework,
        status,
        title,
      };

      console.log(`  Parsed event:`, JSON.stringify(event, null, 2));

      // Add event to the date's events
      if (!eventsByDate[date]) {
        eventsByDate[date] = [];
      }
      eventsByDate[date].push(event);
    });
});

console.log("\n\n=== SUMMARY ===");
console.log(`Total dates: ${Object.keys(eventsByDate).length}`);
for (const [date, events] of Object.entries(eventsByDate)) {
  console.log(`  ${date}: ${events.length} events`);
}

console.log("\n\n=== FULL OUTPUT ===");
console.log(JSON.stringify(eventsByDate, null, 2));
