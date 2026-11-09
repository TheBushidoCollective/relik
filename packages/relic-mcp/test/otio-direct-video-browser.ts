import {
  ALL_FORMATS,
  BufferSource,
  EncodedPacketSink,
  Input,
  VideoSampleSink,
  type VideoSample,
} from '../../relic-viewer/node_modules/mediabunny/dist/modules/src/index.js';

// This module is bundled only for the isolated, loopback-only experiment.
async function inspect(name: string, probes: number[]) {
  const response = await fetch(`/media/${encodeURIComponent(name)}`);
  if (!response.ok) throw new Error(`media request ${response.status}`);
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BufferSource(await response.arrayBuffer()),
  });
  const counts = { opened: 0, closed: 0, maxOwned: 0, cancellations: 0 };
  const capture = (sample: VideoSample) => {
    counts.opened++;
    counts.maxOwned = Math.max(counts.maxOwned, counts.opened - counts.closed);
    try {
      const canvas = new OffscreenCanvas(64, 16);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('2d canvas unavailable');
      ctx.imageSmoothingEnabled = false;
      sample.draw(ctx, 0, 0, 64, 16);
      const data = ctx.getImageData(0, 0, 64, 16).data;
      let binary = '';
      for (const byte of data) binary += String.fromCharCode(byte);
      return {
        timestamp: sample.timestamp,
        duration: sample.duration,
        pixels: btoa(binary),
      };
    } finally {
      sample.close();
      counts.closed++;
    }
  };
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('no video track');
    const config = await track.getDecoderConfig();
    if (!config) throw new Error('no decoder configuration');
    const support = await VideoDecoder.isConfigSupported(config);
    if (!support.supported || !(await track.canDecode()))
      throw new Error(`unsupported decoder ${config.codec}`);
    const packetSink = new EncodedPacketSink(track);
    const key = await packetSink.getKeyPacket(probes[0]!, {
      verifyKeyPackets: true,
    });
    if (!key || key.timestamp > probes[0]! + 0.000002 || key.type !== 'key')
      throw new Error('verified predecessor key packet unavailable');
    const packets: {
      timestamp: number;
      sequenceNumber: number;
      type: string;
    }[] = [];
    for await (const p of packetSink.packets(key)) {
      packets.push({
        timestamp: p.timestamp,
        sequenceNumber: p.sequenceNumber,
        type: p.type,
      });
      if (packets.length >= 24) break;
    }
    if (!packets.length || packets[0]!.sequenceNumber !== key.sequenceNumber)
      throw new Error('packet iteration did not begin at verified key');
    for (let i = 1; i < packets.length; i++)
      if (packets[i]!.sequenceNumber <= packets[i - 1]!.sequenceNumber)
        throw new Error('packets not in decode order');
    const sink = new VideoSampleSink(track);
    const start = performance.now();
    const sequential: {
      timestamp: number;
      duration: number;
      pixels: string;
    }[] = [];
    for await (const sample of sink.samples(0.1, 0.36)) {
      sequential.push(capture(sample));
      if (sequential.length > 16)
        throw new Error('sequential sample bound exceeded');
    }
    const sequentialMs = performance.now() - start;
    const explicit = [];
    for (const time of probes) {
      const before = performance.now();
      const sample = await sink.getSample(time);
      if (!sample) throw new Error(`missing explicit sample at ${time}`);
      explicit.push({
        time,
        latencyMs: performance.now() - before,
        ...capture(sample),
      });
    }
    // Exercise generator cancellation repeatedly. Returning the generator also disposes
    // Mediabunny's internal prefetched samples; only handed-out samples are countable here.
    for (let i = 0; i < 4; i++) {
      const it = sink.samples(0.1, 0.36);
      try {
        const first = await it.next();
        if (first.done || !first.value)
          throw new Error('cancellation iterator empty');
        capture(first.value);
      } finally {
        await it.return(undefined);
        counts.cancellations++;
      }
    }
    if (counts.opened !== counts.closed || counts.maxOwned !== 1)
      throw new Error('sample ownership mismatch');
    return {
      codec: await track.getCodecParameterString(),
      config: {
        codec: config.codec,
        codedWidth: config.codedWidth,
        codedHeight: config.codedHeight,
        descriptionBytes: config.description?.byteLength ?? 0,
      },
      key: {
        timestamp: key.timestamp,
        sequenceNumber: key.sequenceNumber,
        type: key.type,
      },
      packets,
      sequential,
      explicit,
      sequentialMs,
      counts,
    };
  } finally {
    input.dispose();
  }
}
Object.assign(globalThis, { runDirectVideoExperiment: inspect });
