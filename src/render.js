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

const drawCanvas = async (title, subtitle) => {
  await loadFonts();
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  drawCard(canvas, title, subtitle);
  return canvas;
};

/** Fast path: hardware/native encoding through WebCodecs + mediabunny. */
const renderWebCodecs = async ({ title, subtitle, audio }, onProgress) => {
  if (typeof VideoEncoder === 'undefined' || typeof AudioEncoder === 'undefined') {
    throw new Error('WebCodecs is unavailable');
  }

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
  if (!videoCodec || !audioCodec) throw new Error('No encodable MP4 codecs');

  const canvas = await drawCanvas(title, subtitle);
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

  return new Blob([output.target.buffer], { type: 'video/mp4' });
};

// Slow path: ffmpeg compiled to WebAssembly (~30 MB, loaded once on first use).
let ffmpegPromise;
const loadFFmpeg = () =>
  (ffmpegPromise ??= (async () => {
    const [{ FFmpeg }, { default: coreURL }, { default: wasmURL }] = await Promise.all([
      import('@ffmpeg/ffmpeg'),
      import('@ffmpeg/core?url'),
      import('@ffmpeg/core/wasm?url'),
    ]);
    const ffmpeg = new FFmpeg();
    await ffmpeg.load({ coreURL, wasmURL });
    return ffmpeg;
  })().catch((e) => {
    ffmpegPromise = undefined;
    throw e;
  }));

let ffmpegQueue = Promise.resolve(); // ffmpeg.wasm runs one job at a time

const renderFFmpeg = ({ title, subtitle, audio }, onProgress) => {
  const job = ffmpegQueue.then(async () => {
    onProgress?.(0);
    const ffmpeg = await loadFFmpeg();
    const canvas = await drawCanvas(title, subtitle);
    const png = await new Promise((res) => canvas.toBlob(res, 'image/png'));

    await ffmpeg.writeFile('card.png', new Uint8Array(await png.arrayBuffer()));
    await ffmpeg.writeFile('audio', new Uint8Array(await audio.arrayBuffer()));

    // Track the encoder's "time=" output; used for both the audio duration and progress.
    let lastTime = 0;
    let duration = 0;
    const log = ({ message }) => {
      const m = /time=\s*(\d+):(\d+):([\d.]+)/.exec(message);
      if (!m) return;
      lastTime = +m[1] * 3600 + +m[2] * 60 + +m[3];
      if (duration) onProgress?.(Math.min(0.1 + (0.89 * lastTime) / duration, 0.99));
    };
    ffmpeg.on('log', log);
    const run = async (args) => {
      const code = await ffmpeg.exec(args);
      if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);
    };
    try {
      // Step 1: transcode audio on its own to learn its exact length (MediaRecorder files often
      // lack a duration header, and -shortest overshoots with a looped still image).
      await run(['-i', 'audio', '-vn', '-c:a', 'aac', '-b:a', '192k', 'audio.m4a']);
      duration = lastTime;
      if (!duration) throw new Error('Could not determine audio length');
      onProgress?.(0.1);

      // Step 2: loop the card for exactly that long and mux in the audio.
      await run([
        '-loop', '1', '-framerate', '1', '-i', 'card.png',
        '-i', 'audio.m4a',
        '-map', '0:v', '-map', '1:a',
        '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p',
        '-c:a', 'copy',
        '-t', duration.toFixed(3), '-movflags', '+faststart',
        'out.mp4',
      ]);
      const data = await ffmpeg.readFile('out.mp4');
      return new Blob([data], { type: 'video/mp4' });
    } finally {
      ffmpeg.off('log', log);
      for (const f of ['card.png', 'audio', 'audio.m4a', 'out.mp4']) await ffmpeg.deleteFile(f).catch(() => {});
    }
  });
  ffmpegQueue = job.catch(() => {});
  return job;
};

/**
 * Renders a title card + audio blob to an MP4 blob. Uses WebCodecs when the browser supports it and
 * falls back to ffmpeg.wasm otherwise (older browsers/machines).
 */
export const renderVideo = async (input, onProgress) => {
  let video;
  try {
    video = await renderWebCodecs(input, onProgress);
  } catch (e) {
    console.warn('WebCodecs render failed, falling back to ffmpeg.wasm:', e);
    video = await renderFFmpeg(input, onProgress);
  }
  onProgress?.(1);
  return video;
};
