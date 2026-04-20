"use client";

export type PressureLabel = "no_press" | "light" | "firm";

export type TipUV = {
  u: number;
  v: number;
  t: number;
};

export type HandLandmark = {
  x: number;
  y: number;
  z?: number;
};

export type HandsResults = {
  multiHandLandmarks?: HandLandmark[][];
  multiHandedness?: unknown;
};

export type MediaPipeHands = {
  setOptions: (opts: {
    maxNumHands: number;
    modelComplexity: number;
    minDetectionConfidence: number;
    minTrackingConfidence: number;
    selfieMode: boolean;
    staticImageMode: boolean;
  }) => void;
  onResults: (cb: (results: HandsResults) => void) => void;
  send: (input: { image: HTMLVideoElement }) => Promise<void>;
  close: () => void;
};

export type PressurePatchRecord = {
  dataset_id: string;
  label: PressureLabel;
  subject_id: string;
  session_id: string;
  timestamp: number;
  elapsed_ms: number;
  frame_id: number;
  patch_path: string;
  mediapipe_hand_confidence: number | null;
  fingertip_xy: [number, number];
  roi_bbox: { x: number; y: number; w: number; h: number };
  runtime_input_mode: "raw_video_fingertip_crop";
  lighting_tag?: string;
  device_tag?: string;
};

export type PressureSessionSummary = {
  dataset_id: string;
  session_id: string;
  label: PressureLabel;
  subject_id: string;
  started_at: number;
  ended_at: number;
  duration_ms: number;
  frame_count: number;
  sequence_hz: number;
  patch_input_size_px: number;
  patch_output_size_px: number;
  runtime_input_mode: "raw_video_fingertip_crop";
  clip_expected: boolean;
  clip_saved: boolean;
  clip_path: string | null;
  clip_mime_type: string | null;
  patch_paths: string[];
  lighting_tag?: string;
  device_tag?: string;
};

export type PressureDatasetManifest = {
  dataset_id: string;
  created_at: number;
  schema_version: "pressure-temporal-v1";
  runtime_input_mode: "raw_video_fingertip_crop";
  session_ids: string[];
  session_count: number;
  patch_count: number;
  clip_count: number;
  sequence_hz: number;
  session_duration_ms: number;
  label_counts: Record<PressureLabel, number>;
  files: {
    manifest: string;
    sessions_dir: string;
    patches_dir: string;
    clips_dir: string;
    annotations_dir: string;
  };
};

export type PressureSessionReview = {
  dataset_id: string;
  session_id: string;
  original_label: PressureLabel;
  reviewed_label: PressureLabel;
  press_start_frame: number | null;
  press_end_frame: number | null;
  press_start_ms: number | null;
  press_end_ms: number | null;
  keep: boolean;
  quality: "good" | "usable" | "bad";
  has_clip: boolean;
  clip_path: string | null;
  notes: string;
  review_timestamp: number;
};

const SESSION_PREFIX = "pressure-temporal";
const DATASET_PREFIX = "pressure-temporal-dataset";

export function makeSessionId(label: PressureLabel) {
  const t = Date.now();
  const r = Math.floor(Math.random() * 1e6)
    .toString()
    .padStart(6, "0");
  return `${SESSION_PREFIX}-${label}-${t}-${r}`;
}

export function makeDatasetId() {
  const t = Date.now();
  const r = Math.floor(Math.random() * 1e6)
    .toString()
    .padStart(6, "0");
  return `${DATASET_PREFIX}-${t}-${r}`;
}

export async function loadScriptOnce(src: string) {
  if (typeof document === "undefined") return;
  const existed = Array.from(document.scripts).some((script) => script.src === src);
  if (existed) return;

  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`failed to load script: ${src}`));
    document.head.appendChild(script);
  });
}

export function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

export function extractHandConfidence(results: HandsResults): number | null {
  const handedness = results.multiHandedness;
  if (!Array.isArray(handedness) || handedness.length < 1) return null;

  const first = handedness[0] as unknown;
  if (typeof first !== "object" || first == null) return null;

  const directScore = (first as { score?: unknown }).score;
  if (typeof directScore === "number") return directScore;

  const classification = (first as { classification?: unknown }).classification;
  if (!Array.isArray(classification) || classification.length < 1) return null;

  const firstClassification = classification[0] as unknown;
  if (typeof firstClassification !== "object" || firstClassification == null) {
    return null;
  }

  const nestedScore = (firstClassification as { score?: unknown }).score;
  return typeof nestedScore === "number" ? nestedScore : null;
}

export function toErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function msToText(ms: number) {
  const seconds = Math.ceil(ms / 1000);
  return `${seconds}s`;
}

export async function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number
) {
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("toBlob returned null"));
          return;
        }
        resolve(blob);
      },
      type,
      quality
    );
  });
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function isClipLabel(label: PressureLabel) {
  return label === "light" || label === "firm";
}

export function pickRecorderMimeType() {
  if (typeof MediaRecorder === "undefined") return null;

  const preferredTypes = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];

  for (const mimeType of preferredTypes) {
    if (typeof MediaRecorder.isTypeSupported !== "function") return mimeType;
    if (MediaRecorder.isTypeSupported(mimeType)) return mimeType;
  }

  return null;
}

export async function sleep(ms: number) {
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
