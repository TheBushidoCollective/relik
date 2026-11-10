import {
  chromeProgramRenderer,
  installProgramSignalCleanup,
} from '../src/program/render.ts';
installProgramSignalCleanup();
const render = chromeProgramRenderer({
  chromePath: process.env['SIGNAL_SHELL'],
  assetDir: process.env['SIGNAL_ASSET']!,
  profile: { kind: 'private-ram-volume', sizeMiB: 256 },
  deadlineMs: 600000,
});
await render({
  contentText: '{}',
  documentSha256: '0'.repeat(64),
  timelineIds: ['signal-control'],
  media: [],
  readMedia: async () => new Uint8Array(),
  maxBytes: 1000000,
  forceEncoderAbsent: false,
});
throw new Error('render ended before signal');
