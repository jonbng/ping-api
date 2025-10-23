import { readFileSync } from 'fs';
import { join } from 'path';
import { db } from '../lib/firebase-admin';

interface School {
  schoolId: string;
  schoolName: string;
}

async function importSchools() {
  try {
    // Read the schools.html file
    const htmlPath = join(__dirname, '..', 'schools.html');
    const html = readFileSync(htmlPath, 'utf-8');

    // Parse schools using regex
    const schoolRegex = /<a href="\/lectio\/(\d+)\/default\.aspx">([^<]+)<\/a>/g;
    const schools: School[] = [];

    let match;
    while ((match = schoolRegex.exec(html)) !== null) {
      const schoolId = match[1];
      const schoolName = match[2]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .trim();

      // Skip the "Vis alle skoler" link
      if (schoolName !== 'Vis alle skoler') {
        schools.push({ schoolId, schoolName });
      }
    }

    console.log(`Found ${schools.length} schools to import`);

    // Import schools into Firebase
    const batch = db.batch();
    let batchCount = 0;
    let totalCount = 0;

    for (const school of schools) {
      const docRef = db.collection('lectio').doc(school.schoolId);
      batch.set(docRef, {
        schoolName: school.schoolName,
      });

      batchCount++;
      totalCount++;

      // Firestore batch limit is 500 operations
      if (batchCount === 500) {
        await batch.commit();
        console.log(`Committed batch of ${batchCount} schools (${totalCount}/${schools.length})`);
        batchCount = 0;
      }
    }

    // Commit remaining schools
    if (batchCount > 0) {
      await batch.commit();
      console.log(`Committed final batch of ${batchCount} schools (${totalCount}/${schools.length})`);
    }

    console.log(`✅ Successfully imported ${totalCount} schools to Firebase`);

    // Print first few schools as confirmation
    console.log('\nSample of imported schools:');
    schools.slice(0, 5).forEach(school => {
      console.log(`  /lectio/${school.schoolId} - ${school.schoolName}`);
    });

  } catch (error) {
    console.error('❌ Error importing schools:', error);
    process.exit(1);
  }
}

// Run the import
importSchools()
  .then(() => {
    console.log('\n✨ Import completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
