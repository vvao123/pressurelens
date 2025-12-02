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

const sessionId = (() => {
  const t = Date.now();
  const r = Math.floor(Math.random() * 1e6)
    .toString()
    .padStart(6, "0");
  return `session-${t}-${r}`;
})();

const startedAt = Date.now();

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

  setPageOcr(info: PageOcrInfo) {
    pageOcr = info;
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

  exportJson(deviceInfo?: string) {
    if (typeof window === "undefined") return;

    const endedAt = Date.now();
    const payload: SessionJson = {
      sessionId,
      startedAt,
      endedAt,
      deviceInfo,
      config,
      pageOcr,
      pointerSamples,
      voiceAnnotations,
      selectedTopics,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sessionId}.json`;
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
  },
};


