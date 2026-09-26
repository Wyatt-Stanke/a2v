import {
  Output,
  Mp4OutputFormat,
  BufferTarget,
  CanvasSource,
  AudioBufferSource,
  QUALITY_HIGH,
  getFirstEncodableVideoCodec,
  getFirstEncodableAudioCodec,
} from 'mediabunny';
import { WIDTH, HEIGHT, drawCard, loadFonts } from './card.js';

const FRAME_INTERVAL = 1; // seconds; the card is static so 1 fps is plenty

/** Renders a title card + audio blob to an MP4 blob. */
export const renderVideo = async ({ title, subtitle, audio }, onProgress) => {
  const ctx = new AudioContext();
  let buffer;
  try {
    buffer = await ctx.decodeAudioData(await audio.arrayBuffer());
  } finally {
    ctx.close();
  }

  const videoCodec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], {
    width: WIDTH,
    height: HEIGHT,
  });
  const audioCodec = await getFirstEncodableAudioCodec(['aac', 'opus'], {
    numberOfChannels: buffer.numberOfChannels,
    sampleRate: buffer.sampleRate,
  });
  if (!videoCodec || !audioCodec) throw new Error('This browser cannot encode MP4 video/audio.');

  await loadFonts();
  const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
  drawCard(canvas, title, subtitle);

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });
  const video = new CanvasSource(canvas, { codec: videoCodec, quality: QUALITY_HIGH, keyFrameInterval: 5 });
  const sound = new AudioBufferSource({ codec: audioCodec, quality: QUALITY_HIGH });
  output.addVideoTrack(video, { frameRate: 1 / FRAME_INTERVAL });
  output.addAudioTrack(sound);
  await output.start();

  const duration = buffer.duration;
  const audioDone = sound.add(buffer);
  for (let t = 0; t < duration; t += FRAME_INTERVAL) {
    await video.add(t, Math.min(FRAME_INTERVAL, duration - t));
    onProgress?.(Math.min(t / duration, 0.99));
  }
  await audioDone;
  await output.finalize();
  onProgress?.(1);

  return new Blob([output.target.buffer], { type: 'video/mp4' });
};
