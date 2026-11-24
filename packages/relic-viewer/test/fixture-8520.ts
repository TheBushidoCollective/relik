import {
  deriveCommentKey,
  encryptComment,
  encryptRelic,
  generateKey,
  generateRelicId,
  relicUrl,
} from '@relic/format';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';

const PORT = 8520;
const ORIGIN = `http://localhost:${PORT}`;

const storage = new MemoryStorage(ORIGIN);
const store = new MemoryStore();
const assets = diskAssets(new URL('../dist', import.meta.url).pathname);

const app = createApp({
  store,
  storage,
  assets,
  config: {
    serviceOrigin: ORIGIN,
    usercontentOrigin: `http://127.0.0.1:${PORT}`,
  },
});

const relicId = generateRelicId();
const key = generateKey();
const filename = 'discussion.md';
const content = new TextEncoder().encode(
  '# Review Discussion\n\nPlease leave feedback on the architecture plan below.\n\n## Summary\n\nThis is a living relik with threaded comments and Markdown support.\n'
);

const container = await encryptRelic({
  content,
  filename,
  mimetype: 'text/markdown',
  key,
});

storage.put(relicId, container);
await store.putRelic({
  id: relicId,
  version: 1,
  grantedAt: Date.now(),
  expiresAt: undefined,
  publishedAt: Date.now(),
  declaredSizeBytes: content.length,
  publishingClient: 'fixture',
  publishIp: '127.0.0.1',
  publishTokenHash: 'aabbccdd11223344',
  rendererClass: 'markdown',
  title: 'Architecture Review',
  mintsUsed: 0,
  objectLength: container.length,
});

const commentKey = await deriveCommentKey(key);

// Comment 1: long markdown body
const longBody = `# Detailed Feedback on Proposed Layout

Here is a summary of the observations from our initial walkthrough:

- First, the **caching layer** looks solid and handles invalidated entries properly.
- Second, the *database migration* sequence is ordered and deterministic.
- Third, we should verify the fallback rungs under concurrency.

### Code snippet

\`\`\`typescript
interface ConfigOptions {
  retryLimit: number;
  timeoutMs: number;
}
\`\`\`

> Please ensure that all edge cases are addressed before the next milestone.

| Section | Status | Notes |
| --- | --- | --- |
| Cache | Done | Validated locally |
| Storage | Review | Needs wire check |
`;

const c1Ciphertext = await encryptComment(commentKey, {
  body: longBody,
  display_name: 'Grace Hopper',
  anchor: null,
  addresses: null,
});

await store.putComment({
  relicId,
  id: 'c1',
  author: 'grace@example.com',
  ciphertext: c1Ciphertext,
  createdAt: Date.now() - 3600_000,
  version: 1,
});

// Comment 2: reply carrying addresses
const replyBody = `Thanks Grace! I have reviewed your notes and updated the configuration.

We added the retry bounds and verified that the timeout falls back cleanly.`;

const c2Ciphertext = await encryptComment(commentKey, {
  body: replyBody,
  display_name: 'Ada Lovelace',
  anchor: null,
  addresses: 'c1',
});

await store.putComment({
  relicId,
  id: 'c2',
  author: 'ada@example.com',
  ciphertext: c2Ciphertext,
  createdAt: Date.now() - 1800_000,
  version: 1,
});

// Comment 3: hostile body containing raw HTML and javascript: link
const hostileBody = `Attempting hostile payloads in comment:

<script>alert("hostile script execution")</script>
<iframe src="javascript:alert('iframe')"></iframe>
<img src="missing.png" onerror="alert('onerror')">

Here is a suspicious link: [Suspicious Link](javascript:alert(location.hash))
And a data URI link: [Data URI](data:text/html,<script>alert(1)</script>)
`;

const c3Ciphertext = await encryptComment(commentKey, {
  body: hostileBody,
  display_name: 'Attacker',
  anchor: null,
  addresses: null,
});

await store.putComment({
  relicId,
  id: 'c3',
  author: 'attacker@example.com',
  ciphertext: c3Ciphertext,
  createdAt: Date.now() - 600_000,
  version: 1,
});

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // Resolve objects for a real browser from storage
    if (url.pathname.startsWith('/o/')) {
      const objectKey = url.pathname.slice('/o/'.length);
      const bytes = await storage.read(objectKey);
      if (bytes !== undefined) {
        return new Response(bytes as unknown as BodyInit, {
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(bytes.length),
            'access-control-allow-origin': '*',
          },
        });
      }
      return new Response('Not found', { status: 404 });
    }

    return app.fetch(req);
  },
});

const shareUrl = relicUrl(ORIGIN, relicId, key);
console.log(`Relik URL: ${shareUrl}`);
console.log(`ready on ${server.port}`);

if (process.env.FIXTURE_ONESHOT === 'true') {
  // Test probe request to verify server and object resolution
  const mintRes = await fetch(`${ORIGIN}/api/relics/${relicId}/mint`, {
    method: 'POST',
  });
  const mintJson = (await mintRes.json()) as { url: string };
  const objRes = await fetch(mintJson.url);
  const objBytes = await objRes.arrayBuffer();
  if (objBytes.byteLength !== container.length) {
    throw new Error('object resolution length mismatch');
  }

  const commentsRes = await fetch(`${ORIGIN}/api/relics/${relicId}/comments`);
  const commentsJson = (await commentsRes.json()) as unknown[];
  if (commentsJson.length < 3) {
    throw new Error('comments missing');
  }

  console.log('Fixture verification passed');
  process.exit(0);
}
