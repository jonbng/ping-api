import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { db } from "@/lib/firebase-admin";
import { Client, PublishBatchRequest } from "@upstash/qstash";

interface Student {
  name: string;
  studentId: string;
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
  const startTime = Date.now();
  console.log("[Lectio Scheduler] Starting job scheduling...");

  try {
    // Pull just the fields we actually need to keep payloads small
    console.log("[Lectio Scheduler] Fetching students from Firestore...");
    const snapshot = await db
      .collection("lectioCreds")
      .select("studentId", "schoolId")
      .get();

    if (snapshot.empty) {
      console.error(
        "[Lectio Scheduler] No students found. lectioCreds collection is empty."
      );
      return new Response("No students found to schedule.", { status: 200 });
    }

    console.log(
      `[Lectio Scheduler] Found ${snapshot.docs.length} students to schedule.`
    );

    let totalJobs = 0;
    let skippedJobs = 0;
    let batchCount = 0;
    let batch: PublishBatchRequest[] = [];

    // Build QStash jobs and flush every BATCH_SIZE_LIMIT to avoid big in-memory arrays
    for (const doc of snapshot.docs) {
      const student = doc.data() as Student;

      // Guard against malformed docs
      if (!student?.studentId || !student?.schoolId) {
        skippedJobs++;
        console.warn(
          `[Lectio Scheduler] Skipping malformed document: ${doc.id} (missing studentId or schoolId)`
        );
        continue;
      }

      batch.push({
        body: JSON.stringify({
          studentId: student.studentId,
          schoolId: student.schoolId
        }),
        queueName: "lectioUserScrape",
        url: "https://api.joinping.dk/lectio/student/scrape",
        retryDelay: "10000",
        retries: 2,
      });

      if (batch.length >= BATCH_SIZE_LIMIT) {
        batchCount++;
        console.log(
          `[Lectio Scheduler] Sending batch ${batchCount} with ${batch.length} jobs...`
        );
        await client.batchJSON(batch);
        totalJobs += batch.length;
        console.log(
          `[Lectio Scheduler] Batch ${batchCount} sent successfully. Total jobs: ${totalJobs}`
        );
        batch = [];
      }
    }

    // Flush any remainder
    if (batch.length > 0) {
      batchCount++;
      console.log(
        `[Lectio Scheduler] Sending final batch ${batchCount} with ${batch.length} jobs...`
      );
      await client.batchJSON(batch);
      totalJobs += batch.length;
      console.log(
        `[Lectio Scheduler] Final batch sent successfully. Total jobs: ${totalJobs}`
      );
    }

    const duration = Date.now() - startTime;
    const batches = Math.ceil(totalJobs / BATCH_SIZE_LIMIT) || 0;

    console.log(
      `[Lectio Scheduler] ✓ Successfully scheduled ${totalJobs} jobs across ${batches} batches in ${duration}ms`
    );
    if (skippedJobs > 0) {
      console.warn(
        `[Lectio Scheduler] Skipped ${skippedJobs} malformed documents`
      );
    }

    return new Response(
      `Successfully scheduled ${totalJobs} scraping jobs across ${batches} batches.`
    );
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[Lectio Scheduler] ✗ Failed after ${duration}ms:`, error);
    return new Response(
      `Failed to schedule scraping jobs: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
      { status: 500 }
    );
  }
});
