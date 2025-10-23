import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { db } from "@/lib/firebase-admin";
import { Client, PublishBatchRequest } from "@upstash/qstash";

interface School {
  schoolId: string;
  schoolName: string;
}

interface Student {
  name: string;
  elevId: string;
  schoolId: string;
}

const client = new Client();

// QStash batch size limit (conservative estimate)
const BATCH_SIZE_LIMIT = 100;

// Endpoint that schedules scraping jobs for all Lectio students across all schools
export const POST = verifySignatureAppRouter(async () => {
  try {
    // Get all schools
    const schools = (await db.collection("lectio").get()).docs;

    // Prepare batch of jobs to queue
    const batch: PublishBatchRequest[] = [];

    // Fetch all students from all schools in parallel
    const schoolsData = schools.map((doc) => doc.data() as School);
    const studentsPromises = schoolsData.map((school) =>
      db.collection(`lectio/${school.schoolId}/students`).get()
    );
    const studentsSnapshots = await Promise.all(studentsPromises);

    // Create a scrape job for each student
    for (const studentsSnapshot of studentsSnapshots) {
      for (const studentDoc of studentsSnapshot.docs) {
        const student = studentDoc.data() as Student;
        batch.push({
          body: JSON.stringify(student),
          queueName: "lectioUserScrape",
          url: "https://api.joinping.dk/lectio/student/scrape",
        });
      }
    }

    // Check if there are any jobs to schedule
    if (batch.length === 0) {
      return new Response("No students found to schedule.", { status: 200 });
    }

    // Send jobs in chunks to respect batch size limits
    const chunks: PublishBatchRequest[][] = [];
    for (let i = 0; i < batch.length; i += BATCH_SIZE_LIMIT) {
      chunks.push(batch.slice(i, i + BATCH_SIZE_LIMIT));
    }

    // Send all chunks in parallel
    await Promise.all(chunks.map((chunk) => client.batchJSON(chunk)));

    return new Response(
      `Successfully scheduled ${batch.length} scraping jobs across ${chunks.length} batches.`
    );
  } catch (error) {
    console.error("Error scheduling Lectio scraping jobs:", error);
    return new Response(
      `Failed to schedule scraping jobs: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
      { status: 500 }
    );
  }
});
