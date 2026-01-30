import JSZip from "jszip";
import type {
  PointerSample,
  PointerSampleInput,
  SessionJson,
  PageOcrInfo,
  VoiceAnnotation,
  SelectedTopic,
} from "./types";

let pointerSamples: PointerSample[] = [];
let voiceAnnotations: VoiceAnnotation[] = [];
let pageOcr: PageOcrInfo | undefined;
let selectedTopics: SelectedTopic[] = [];
let voiceAudio: Record<string, { blob: Blob; type: string }> = {};

const makeSessionId = (prefix: string) => {
  const t = Date.now();
  const r = Math.floor(Math.random() * 1e6)
    .toString()
    .padStart(6, "0");
  return `${prefix}-${t}-${r}`;
};

const formatOcrDateTime = (timeMs: number) => {
  const d = new Date(timeMs);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
};

const makeGlobalSessionId = () => `ocr-${formatOcrDateTime(Date.now())}`;

const getAudioExtension = (mimeType: string) => {
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp3") || mimeType.includes("mpeg")) return "mp3";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("m4a") || mimeType.includes("mp4")) return "m4a";
  return "webm";
};

let sessionId = makeSessionId("session");
let globalSessionId = makeGlobalSessionId();

let pageIndex = 1;

let startedAt = Date.now();

const config = {
  samplingHz: 10,
};

function computeSpeed(prev: PointerSample | undefined, current: PointerSampleInput): number {
  if (!prev) return current.speed ?? 0;
  const dt = current.timestamp - prev.timestamp;
  if (dt <= 0) return current.speed ?? 0;
  const dx = current.x - prev.x;
  const dy = current.y - prev.y;
  const dist = Math.hypot(dx, dy);
  return (dist / dt) * 1000; // px/s
}

export const sessionLogger = {
  addPointerSample(sample: PointerSampleInput) {
    const prev = pointerSamples[pointerSamples.length - 1];
    const speed = computeSpeed(prev, sample);
    const full: PointerSample = {
      ...sample,
      speed,
    };
    pointerSamples.push(full);
  },

  addVoiceAnnotation(annotation: VoiceAnnotation) {
    voiceAnnotations.push(annotation);
  },

  addSelectedTopic(topic: SelectedTopic) {
    selectedTopics.push(topic);
  },

  addVoiceAudio(id: string, blob: Blob) {
    if (!id || !blob || blob.size === 0) return;
    voiceAudio[id] = { blob, type: blob.type || "audio/webm" };
  },

  setPageOcr(info: PageOcrInfo) {
    pageOcr = info;
  },

  setPageIndex(index: number) {
    if (!Number.isFinite(index)) return;
    pageIndex = Math.max(1, Math.floor(index));
  },

  getSummary() {
    return {
      sessionId,
      pointerSamples: pointerSamples.length,
      voiceAnnotations: voiceAnnotations.length,
      selectedTopics: selectedTopics.length,
      hasPageOcr: !!pageOcr,
    };
  },

  async exportJson(deviceInfo?: string) {
    if (typeof window === "undefined") return;

    const endedAt = Date.now();
    const payload: SessionJson = {
      sessionId,
      globalSessionId,
      pageIndex,
      startedAt,
      endedAt,
      deviceInfo,
      config,
      pageOcr,
      pointerSamples,
      voiceAnnotations,
      selectedTopics,
    };

    const jsonBlob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const zip = new JSZip();
    const baseName = `${globalSessionId}-page-${pageIndex}`;
    zip.file(`${baseName}.json`, jsonBlob);
    Object.entries(voiceAudio).forEach(([id, { blob, type }]) => {
      const ext = getAudioExtension(type);
      zip.file(`audio/${id}.${ext}`, blob);
    });
    const zipBlob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${baseName}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  reset() {
    pointerSamples = [];
    voiceAnnotations = [];
    pageOcr = undefined;
    selectedTopics = [];
    voiceAudio = {};
  },

  resetSessionIds(options?: { resetGlobal?: boolean; resetPageIndex?: boolean }) {
    const { resetGlobal = true, resetPageIndex = true } = options ?? {};
    sessionId = makeSessionId("session");
    if (resetGlobal) {
      globalSessionId = makeGlobalSessionId();
    }
    if (resetPageIndex) {
      pageIndex = 1;
    }
    startedAt = Date.now();
  },
};


