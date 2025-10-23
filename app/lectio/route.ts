import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { db } from "@/lib/firebase-admin";
import { Client, PublishBatchRequest } from "@upstash/qstash";

interface Student {
  name: string;
  elevId: string;
  schoolId: string;
}

// QStash conservative batch size
const BATCH_SIZE_LIMIT = 100;

// Single QStash client
const client = new Client();

/**
 * POST /api/whatever
 * Schedules scraping jobs for ALL Lectio students across ALL schools
 * using a Firestore collectionGroup("students") query.
 */
export const POST = verifySignatureAppRouter(async () => {
  try {
    // Pull just the fields we actually need to keep payloads small
    const snapshot = await db
      .collection("lectioCreds")
      .select("studentId", "schoolId")
      .get();

    if (snapshot.empty) {
      return new Response("No students found to schedule.", { status: 200 });
    }

    let totalJobs = 0;
    let batch: PublishBatchRequest[] = [];

    // Build QStash jobs and flush every BATCH_SIZE_LIMIT to avoid big in-memory arrays
    for (const doc of snapshot.docs) {
      const student = doc.data() as Student;

      // Guard against malformed docs
      if (!student?.elevId || !student?.schoolId) continue;

      batch.push({
        body: JSON.stringify(student),
        queueName: "lectioUserScrape",
        url: "https://api.joinping.dk/lectio/student/scrape",
      });

      if (batch.length >= BATCH_SIZE_LIMIT) {
        await client.batchJSON(batch);
        totalJobs += batch.length;
        batch = [];
      }
    }

    // Flush any remainder
    if (batch.length > 0) {
      await client.batchJSON(batch);
      totalJobs += batch.length;
    }

    const batches = Math.ceil(totalJobs / BATCH_SIZE_LIMIT) || 0;
    return new Response(
      `Successfully scheduled ${totalJobs} scraping jobs across ${batches} batches.`
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
