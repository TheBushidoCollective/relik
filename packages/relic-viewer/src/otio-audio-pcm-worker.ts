/// <reference lib="webworker" />
import {
  AudioSample,
  CustomSource,
  EncodedPacketSink,
  Input,
  WAVE,
} from 'mediabunny';
import {
  OTIO_PCM_MAX_HORIZON_SECONDS,
  OTIO_PCM_MAX_STREAMS,
  OTIO_PCM_PACKET_FRAMES,
  OTIO_PCM_PROTOCOL,
  type PcmWorkerRequest,
  type PcmWorkerResponse,
} from './otio-audio-pcm-protocol';
import {
  preflightWavePcm,
  wavePcmDataView,
  type WavePcmHeader,
} from './otio-wave-pcm';

interface Stream {
  input: Input;
  sink: EncodedPacketSink;
  header: WavePcmHeader;
  cancelled: boolean;
}
const streams = new Map<string, Stream>();
const versions = new Map<string, number>();
const key = (generation: number, streamId: string) =>
  `${generation}:${streamId}`;
const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<PcmWorkerRequest>) => {
  const message = event.data;
  if (
    !message ||
    message.protocol !== OTIO_PCM_PROTOCOL ||
    !Number.isSafeInteger(message.generation) ||
    typeof message.streamId !== 'string' ||
    !message.streamId
  )
    return;
  const id = key(message.generation, message.streamId);
  if (message.kind === 'cancel') {
    versions.set(id, (versions.get(id) ?? 0) + 1);
    const stream = streams.get(id);
    if (stream) {
      stream.cancelled = true;
      stream.input.dispose();
      streams.delete(id);
    }
    return;
  }
  const version = versions.get(id) ?? 0;
  const send = (response: PcmWorkerResponse, transfer: Transferable[] = []) =>
    scope.postMessage(response, transfer);
  const base = {
    protocol: OTIO_PCM_PROTOCOL,
    generation: message.generation,
    streamId: message.streamId,
    requestId: message.requestId,
  } as const;
  void (async () => {
    try {
      if (message.kind === 'open') {
        if (streams.has(id) || streams.size >= OTIO_PCM_MAX_STREAMS)
          throw new Error('PCM stream limit exceeded');
        const header = await preflightWavePcm(message.blob);
        if (JSON.stringify(header) !== JSON.stringify(message.header))
          throw new Error('WAV header mismatch');
        const dataView = wavePcmDataView(message.blob, header);
        const input = new Input({
          formats: [WAVE],
          source: new CustomSource({
            getSize: () => dataView.size,
            read: dataView.read,
            maxCacheSize: 0,
            prefetchProfile: 'none',
          }),
        });
        try {
          const tracks = await input.getAudioTracks();
          if (tracks.length !== 1 || (await input.getTracks()).length !== 1)
            throw new Error('Unexpected WAV tracks');
          const config = await tracks[0]!.getDecoderConfig();
          if (
            !config ||
            config.numberOfChannels !== header.channels ||
            config.sampleRate !== header.sampleRate ||
            config.codec !== (header.format === 'pcm16' ? 'pcm-s16' : 'pcm-f32')
          )
            throw new Error('WAV decoder configuration mismatch');
          if ((versions.get(id) ?? 0) !== version)
            throw new Error('PCM stream cancelled');
          streams.set(id, {
            input,
            sink: new EncodedPacketSink(tracks[0]!),
            header,
            cancelled: false,
          });
          send({ ...base, kind: 'ready', header });
        } catch (error) {
          input.dispose();
          throw error;
        }
        return;
      }
      if (message.kind === 'close') {
        versions.set(id, (versions.get(id) ?? 0) + 1);
        const stream = streams.get(id);
        if (stream) {
          stream.cancelled = true;
          stream.input.dispose();
          streams.delete(id);
        }
        send({ ...base, kind: 'closed' });
        return;
      }
      if (message.kind !== 'pull') throw new Error('Unknown PCM request');
      const stream = streams.get(id);
      if (!stream || stream.cancelled) throw new Error('PCM stream is closed');
      const { firstFrame, frameCount } = message,
        h = stream.header;
      if (
        !Number.isSafeInteger(firstFrame) ||
        !Number.isSafeInteger(frameCount) ||
        firstFrame < 0 ||
        frameCount <= 0 ||
        frameCount > Math.floor(h.sampleRate * OTIO_PCM_MAX_HORIZON_SECONDS) ||
        firstFrame + frameCount > h.totalFrames
      )
        throw new Error('Invalid PCM frame range');
      const planes = Array.from(
        { length: h.channels },
        () => new Float32Array(frameCount)
      );
      let frame = firstFrame,
        outputOffset = 0;
      let packet = await stream.sink.getPacket(
        (Math.floor(firstFrame / OTIO_PCM_PACKET_FRAMES) *
          OTIO_PCM_PACKET_FRAMES +
          0.5) /
          h.sampleRate
      );
      while (outputOffset < frameCount) {
        if (stream.cancelled) throw new Error('PCM stream cancelled');
        const index = Math.floor(frame / OTIO_PCM_PACKET_FRAMES),
          packetFirst = index * OTIO_PCM_PACKET_FRAMES;
        const packetFrames = Math.min(
          OTIO_PCM_PACKET_FRAMES,
          h.totalFrames - packetFirst
        );
        if (
          !packet ||
          packet.sequenceNumber !== index ||
          Math.abs(packet.timestamp * h.sampleRate - packetFirst) > 1e-6 ||
          Math.abs(packet.duration * h.sampleRate - packetFrames) > 1e-6 ||
          packet.data.byteLength !== packetFrames * h.blockAlign
        )
          throw new Error('WAV packet discontinuity');
        if (h.format === 'float32') {
          const data = new DataView(
            packet.data.buffer,
            packet.data.byteOffset,
            packet.data.byteLength
          );
          for (let offset = 0; offset < data.byteLength; offset += 4)
            if (!Number.isFinite(data.getFloat32(offset, true)))
              throw new Error('Nonfinite PCM sample');
        }
        const offset = frame - packetFirst,
          count = Math.min(frameCount - outputOffset, packetFrames - offset);
        const sample = new AudioSample({
          data: packet.data,
          format: h.format === 'pcm16' ? 's16' : 'f32',
          numberOfChannels: h.channels,
          sampleRate: h.sampleRate,
          timestamp: packet.timestamp,
        });
        try {
          for (let channel = 0; channel < h.channels; channel++)
            sample.copyTo(
              planes[channel]!.subarray(outputOffset, outputOffset + count),
              {
                planeIndex: channel,
                format: 'f32-planar',
                frameOffset: offset,
                frameCount: count,
              }
            );
        } finally {
          sample.close();
        }
        frame += count;
        outputOffset += count;
        if (outputOffset < frameCount)
          packet = await stream.sink.getNextPacket(packet);
      }
      if (stream.cancelled) throw new Error('PCM stream cancelled');
      send(
        { ...base, kind: 'pcm', firstFrame, frameCount, planes },
        planes.map((plane) => plane.buffer as ArrayBuffer)
      );
    } catch (error) {
      send({
        ...base,
        kind: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  })();
};
