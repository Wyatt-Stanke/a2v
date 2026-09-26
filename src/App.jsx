import { createSignal, createEffect, onCleanup, For, Show } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { zipSync } from 'fflate';
import { drawCard, loadFonts, WIDTH, HEIGHT } from './card.js';
import { renderVideo } from './render.js';

let nextId = 1;
const newRow = () => ({
  id: nextId++,
  title: '',
  subtitle: '',
  audio: null, // Blob
  audioUrl: null,
  recording: false,
  status: 'idle', // idle | rendering | done | error
  progress: 0,
  video: null, // Blob
  error: '',
});

const slug = (s, i) =>
  (s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `clip-${i + 1}`).slice(0, 60);

const download = (blob, name) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

const fileNames = (rows) => {
  const used = new Map();
  return rows.map((r, i) => {
    const base = slug(r.title, i);
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return `${n > 1 ? `${base}-${n}` : base}.mp4`;
  });
};

function CardPreview(props) {
  let canvas;
  const [fontsReady, setFontsReady] = createSignal(false);
  loadFonts().then(() => setFontsReady(true));
  createEffect(() => {
    fontsReady();
    drawCard(canvas, props.title, props.subtitle);
  });
  return <canvas ref={canvas} class="preview" width={WIDTH} height={HEIGHT} />;
}

function Recorder(props) {
  let recorder = null;
  let stream = null;
  const [elapsed, setElapsed] = createSignal(0);
  let timer;

  const start = async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      props.onError('Microphone access was denied.');
      return;
    }
    const chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(timer);
      props.onRecorded(new Blob(chunks, { type: recorder.mimeType }));
    };
    recorder.start();
    const t0 = Date.now();
    setElapsed(0);
    timer = setInterval(() => setElapsed((Date.now() - t0) / 1000), 200);
    props.onRecording(true);
  };

  const stop = () => {
    recorder?.state === 'recording' && recorder.stop();
    props.onRecording(false);
  };

  onCleanup(() => {
    clearInterval(timer);
    stream?.getTracks().forEach((t) => t.stop());
  });

  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  return (
    <div class="recorder">
      <Show
        when={props.recording}
        fallback={
          <>
            <Show when={props.audioUrl}>
              <audio controls src={props.audioUrl} />
            </Show>
            <button class="btn" onClick={start} disabled={props.disabled}>
              <span class="dot" />
              {props.audioUrl ? 'Re-record' : 'Record'}
            </button>
          </>
        }
      >
        <div class="live">
          <span class="dot pulse" /> Recording {fmt(elapsed())}
        </div>
        <button class="btn" onClick={stop}>
          <span class="square" /> Stop
        </button>
      </Show>
    </div>
  );
}

export default function App() {
  const [rows, setRows] = createStore([newRow()]);
  const [zipping, setZipping] = createSignal(false);

  const update = (id, patch) => setRows((r) => r.id === id, patch);
  const indexOf = (id) => rows.findIndex((r) => r.id === id);

  const setAudio = (id, blob) => {
    const row = rows[indexOf(id)];
    if (row.audioUrl) URL.revokeObjectURL(row.audioUrl);
    update(id, { audio: blob, audioUrl: URL.createObjectURL(blob), video: null, status: 'idle', error: '' });
  };

  const edit = (id, field, value) => update(id, { [field]: value, video: null, status: 'idle' });

  const remove = (id) => {
    const row = rows[indexOf(id)];
    if (row.audioUrl) URL.revokeObjectURL(row.audioUrl);
    setRows((list) => list.filter((r) => r.id !== id));
  };

  const ready = (r) => r.audio && !r.recording;

  const generate = async (id) => {
    const r = rows[indexOf(id)];
    if (r.video) return r.video;
    update(id, { status: 'rendering', progress: 0, error: '' });
    try {
      const video = await renderVideo(
        { title: r.title, subtitle: r.subtitle, audio: r.audio },
        (p) => update(id, { progress: p }),
      );
      update(id, { status: 'done', video });
      return video;
    } catch (e) {
      console.error(e);
      update(id, { status: 'error', error: e.message || String(e) });
      return null;
    }
  };

  const downloadOne = async (id) => {
    const video = await generate(id);
    const i = indexOf(id);
    if (video) download(video, fileNames(rows)[i]);
  };

  const downloadAll = async () => {
    setZipping(true);
    try {
      const names = fileNames(rows);
      const files = {};
      for (const [i, r] of rows.entries()) {
        if (!ready(r)) continue;
        const video = await generate(r.id);
        if (video) files[names[i]] = [new Uint8Array(await video.arrayBuffer()), { level: 0 }];
      }
      if (Object.keys(files).length) download(new Blob([zipSync(files)], { type: 'application/zip' }), 'clips.zip');
    } finally {
      setZipping(false);
    }
  };

  const readyCount = () => rows.filter(ready).length;
  const busy = () => zipping() || rows.some((r) => r.status === 'rendering');

  return (
    <main>
      <header>
        <div>
          <h1>Audio → Video</h1>
          <p class="lede">Record a clip, give it a title, and export it as an MP4 with a title card. Everything happens in your browser.</p>
        </div>
        <button class="btn primary" onClick={downloadAll} disabled={busy() || readyCount() === 0}>
          {zipping() ? 'Preparing…' : `Download all (${readyCount()})`}
        </button>
      </header>

      <ol class="rows">
        <For each={rows}>
          {(row, i) => (
            <li class="row">
              <span class="num">{String(i() + 1).padStart(2, '0')}</span>
              <div class="fields">
                <input
                  class="title"
                  placeholder="Title"
                  value={row.title}
                  onInput={(e) => edit(row.id, 'title', e.currentTarget.value)}
                />
                <input
                  placeholder="Subtitle (optional)"
                  value={row.subtitle}
                  onInput={(e) => edit(row.id, 'subtitle', e.currentTarget.value)}
                />
                <Recorder
                  audioUrl={row.audioUrl}
                  recording={row.recording}
                  disabled={row.status === 'rendering' || rows.some((r) => r.recording)}
                  onRecording={(v) => update(row.id, { recording: v })}
                  onRecorded={(b) => setAudio(row.id, b)}
                  onError={(msg) => update(row.id, { status: 'error', error: msg })}
                />
                <Show when={row.status === 'error'}>
                  <p class="error">{row.error}</p>
                </Show>
              </div>
              <div class="side">
                <CardPreview title={row.title} subtitle={row.subtitle} />
                <div class="actions">
                  <button
                    class="btn"
                    onClick={() => downloadOne(row.id)}
                    disabled={!ready(row) || row.status === 'rendering'}
                  >
                    {row.status === 'rendering' ? `Rendering ${Math.round(row.progress * 100)}%` : 'Download MP4'}
                  </button>
                  <button
                    class="btn ghost"
                    onClick={() => remove(row.id)}
                    disabled={rows.length === 1 || row.recording || row.status === 'rendering'}
                    title="Remove row"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </li>
          )}
        </For>
      </ol>

      <button class="btn add" onClick={() => setRows(produce((r) => r.push(newRow())))}>
        + Add row
      </button>
    </main>
  );
}
