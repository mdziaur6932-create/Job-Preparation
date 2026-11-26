import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import firebaseConfig from '../../firebase-applet-config.json';

test('firebase-applet-config.json has valid non-placeholder projectId and named firestoreDatabaseId', () => {
  assert.ok(firebaseConfig.projectId && firebaseConfig.projectId !== 'remixed-project-id');
  assert.ok(firebaseConfig.apiKey && firebaseConfig.apiKey.startsWith('AIza'));
  assert.ok(firebaseConfig.appId && firebaseConfig.appId.includes(':web:'));
  assert.equal(
    firebaseConfig.firestoreDatabaseId,
    'ai-studio-aipersonalaijobp-37cb95c8-2b11-4e6c-a7ec-f52ecdb4692d'
  );
});

test('src/lib/firebase.ts uses forced long-polling with memoryLocalCache and passes named firestoreDatabaseId', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/firebase.ts'), 'utf8');
  assert.match(src, /experimentalForceLongPolling:\s*true/);
  assert.doesNotMatch(
    src,
    /experimentalAutoDetectLongPolling:\s*true/,
    'experimentalForceLongPolling and experimentalAutoDetectLongPolling are mutually exclusive'
  );
  assert.match(src, /memoryLocalCache\(\)/);
  assert.doesNotMatch(
    src,
    /persistentMultipleTabManager\s*\(/,
    'Avoid persistentMultipleTabManager IndexedDB lease deadlocks inside preview iframes'
  );
  assert.match(src, /initializeFirestore\([\s\S]*firebaseConfig\.firestoreDatabaseId/);
  assert.match(src, /getFirestore\(app,\s*firebaseConfig\.firestoreDatabaseId\)/);
  assert.match(src, /getDocFromServer\(doc\(db,\s*'test',\s*'connection'\)\)/);
});
