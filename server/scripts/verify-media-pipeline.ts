/** Synthetic provider probe: requires LOCAL test DB, deletes provider asset on exit. */
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

async function main() {
  const db = new URL(process.env.DATABASE_URL || '');
  if (!['localhost', '127.0.0.1'].includes(db.hostname) || !db.pathname.includes('test'))
    throw new Error('Local test database required');
  const { openVideoUpload, completeVideoUpload } = await import('../src/lib/mediaUploadSession.js');
  const { destroyCloudinaryAsset } = await import('../src/lib/cloudinary.js');
  const { prisma } = await import('../src/lib/prisma.js');
  const bytes = await fs.readFile(process.argv[2] || '/tmp/varsityhub-media-probe.mp4');
  if (bytes.length > 12 * 1024 * 1024) throw new Error('Fixture must be <=12 MB');
  const owner = `media-probe-${crypto.randomUUID()}`;
  const id = crypto.randomUUID();
  let session: Awaited<ReturnType<typeof openVideoUpload>> | undefined;
  try {
    const started = Date.now();
    session = await openVideoUpload(owner, { id, content_type: 'video/mp4', bytes: bytes.length });
    for (let start = 0; start < bytes.length; start += 6 * 1024 * 1024) {
      const end = Math.min(bytes.length, start + 6 * 1024 * 1024);
      if (start > 0) {
        const resumed = await openVideoUpload(owner, {
          id,
          content_type: 'video/mp4',
          bytes: bytes.length,
        });
        if (resumed.id !== session.id) throw new Error('Session changed across reconnect');
      }
      const form = new FormData();
      form.append(
        'file',
        new Blob([bytes.subarray(start, end)], { type: 'video/mp4' }),
        'probe.mp4'
      );
      for (const [key, value] of Object.entries(session.fields)) form.append(key, String(value));
      const response = await fetch(session.upload_url, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(90000),
        headers: {
          'X-Unique-Upload-Id': session.id,
          'Content-Range': `bytes ${start}-${end - 1}/${bytes.length}`,
        },
      });
      const result = (await response.json()) as any;
      if (!response.ok)
        throw new Error(
          `Provider rejected chunk: ${response.status} ${result.error?.message || ''}`
        );
      if (end === bytes.length && result.done !== true)
        throw new Error('Final chunk not acknowledged');
      console.log(`Chunk acknowledged ${end}/${bytes.length}, done=${result.done}`);
    }
    const transferMs = Date.now() - started;
    console.log(JSON.stringify({ stage: 'transferred', bytes: bytes.length, transferMs }));
    for (let poll = 0; poll < 30; poll++) {
      console.log(JSON.stringify({ stage: 'completion', poll, elapsedMs: Date.now() - started }));
      const completed = await completeVideoUpload(owner, session.id);
      if (completed.state === 'ready') {
        const result = completed.result as Record<string, any>;
        const manifest = await fetch(result.streaming_url, { signal: AbortSignal.timeout(20000) });
        if (!manifest.ok || !(await manifest.text()).startsWith('#EXTM3U'))
          throw new Error('Invalid HLS manifest');
        const media = await fetch(result.url, {
          headers: { Range: 'bytes=0-1023' },
          signal: AbortSignal.timeout(20000),
        });
        if (media.status !== 206)
          throw new Error(`Expected MP4 range206, received ${media.status}`);
        await media.arrayBuffer();
        const streams = JSON.parse(
          execFileSync(
            'ffprobe',
            [
              '-v',
              'error',
              '-show_entries',
              'stream=codec_type,codec_name,width,height',
              '-of',
              'json',
              result.url,
            ],
            { timeout: 30000, encoding: 'utf8' }
          )
        ).streams;
        const video = streams.find((stream: any) => stream.codec_type === 'video');
        const expectedLongEdge = Math.min(1920, Math.max(result.width, result.height));
        if (
          video?.codec_name !== 'h264' ||
          Math.max(video.width, video.height) < expectedLongEdge - 2
        )
          throw new Error('Prepared MP4 lost expected resolution or codec compatibility');
        console.log(
          JSON.stringify({
            bytes: bytes.length,
            transferMs,
            totalMs: Date.now() - started,
            playbackWidth: video.width,
            playbackHeight: video.height,
            hasAudio: streams.some((stream: any) => stream.codec_type === 'audio'),
          })
        );
        console.log(
          'PASS: chunks, resumed session, verified metadata, prepared HLS and MP4 range delivery'
        );
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    throw new Error('Processing did not finish within probe window');
  } finally {
    if (session) {
      const removed = await destroyCloudinaryAsset(session.fields.public_id, 'video');
      if (!removed.ok) throw new Error('Provider cleanup failed; session retained for cleanup');
      console.log('Synthetic provider asset deleted');
      await prisma.mediaUpload.delete({ where: { id: session.id } });
    }
    await prisma.$disconnect();
  }
}
main().catch(error => {
  console.error(error.message);
  if (error.validation) console.error(JSON.stringify(error.validation));
  process.exitCode = 1;
});
