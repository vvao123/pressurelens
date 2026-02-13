"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import Link from "next/link";

type PressureLabel = "no_press" | "light" | "firm";

type TipUV = { u: number; v: number; t: number };

type HandLandmark = { x: number; y: number; z?: number };
type HandsResults = {
  multiHandLandmarks?: HandLandmark[][];
  multiHandedness?: unknown;
};

type MediaPipeHands = {
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

type CollectorConfig = {
  samplingHz: number; // patch sampling
  pressDurationMs: number;
  patchInputSizePx: number; // crop size in source video pixels
  patchOutputSizePx: number; // final patch size
  jpegQuality: number;
  tipVCompensation: number; // push fingertip up near bottom (0.00 ~ 0.10)
};

type JsonlPatchRecord = {
  label: PressureLabel;
  subject_id: string;
  session_id: string;
  timestamp: number;
  frame_id: number;
  mediapipe_hand_confidence: number | null;
  fingertip_xy: [number, number];
  roi_bbox: { x: number; y: number; w: number; h: number };
  lighting_tag?: string;
  device_tag?: string;
};

const makeSessionId = (label: PressureLabel) => {
  const t = Date.now();
  const r = Math.floor(Math.random() * 1e6)
    .toString()
    .padStart(6, "0");
  return `pressure-collect-${label}-${t}-${r}`;
};

const makeDatasetId = () => {
  const t = Date.now();
  const r = Math.floor(Math.random() * 1e6)
    .toString()
    .padStart(6, "0");
  return `pressure-dataset-${t}-${r}`;
};

async function loadScriptOnce(src: string) {
  if (typeof document === "undefined") return;
  // already loaded?
  const existed = Array.from(document.scripts).some((s) => s.src === src);
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

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function extractHandConfidence(results: HandsResults): number | null {
  const mh = results.multiHandedness;
  if (!Array.isArray(mh) || mh.length < 1) return null;
  const first = mh[0] as unknown;
  if (typeof first !== "object" || first == null) return null;
  const score = (first as { score?: unknown }).score;
  if (typeof score === "number") return score;
  const classification = (first as { classification?: unknown }).classification;
  if (Array.isArray(classification) && classification.length > 0) {
    const c0 = classification[0] as unknown;
    if (typeof c0 === "object" && c0 != null) {
      const s0 = (c0 as { score?: unknown }).score;
      if (typeof s0 === "number") return s0;
    }
  }
  return null;
}

function toErrorMessage(e: unknown) {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function msToText(ms: number) {
  const s = Math.ceil(ms / 1000);
  return `${s}s`;
}

async function canvasToJpegBlob(canvas: HTMLCanvasElement, quality: number) {
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => {
        if (!b) reject(new Error("toBlob returned null"));
        else resolve(b);
      },
      "image/jpeg",
      quality
    );
  });
}

export default function PressureDataCollector() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const handsRef = useRef<MediaPipeHands | null>(null);
  const rafRef = useRef<number | null>(null);

  const latestTipRef = useRef<TipUV | null>(null);
  const latestHandConfidenceRef = useRef<number | null>(null);

  const patchCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Dataset (multi-session) buffer
  const datasetIdRef = useRef<string>(makeDatasetId());
  const datasetZipRef = useRef<JSZip>(new JSZip());
  const datasetJsonlLinesRef = useRef<string[]>([]);
  const datasetSessionIdsRef = useRef<string[]>([]);

  const [label, setLabel] = useState<PressureLabel>("light");
  const [subjectId, setSubjectId] = useState<string>("");
  const [lightingTag, setLightingTag] = useState<string>("");
  const [deviceTag, setDeviceTag] = useState<string>("");
  const [status, setStatus] = useState<
    "idle" | "camera-starting" | "ready" | "pressing" | "exporting" | "error"
  >("idle");
  const [message, setMessage] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [isHandTracking, setIsHandTracking] = useState<boolean>(false);
  const [tipForUI, setTipForUI] = useState<{ x: number; y: number } | null>(null);

  const [capturedCount, setCapturedCount] = useState<number>(0);
  const [datasetSessionCount, setDatasetSessionCount] = useState<number>(0);
  const [datasetPatchCount, setDatasetPatchCount] = useState<number>(0);

  const config: CollectorConfig = useMemo(
    () => ({
      samplingHz: 5,
      pressDurationMs: 3000,
      // Avoid upscaling (which looks blurry). Keep crop == output for maximum sharpness.
      patchInputSizePx: 224,
      patchOutputSizePx: 224,
      jpegQuality: 0.92,
      tipVCompensation: 0.0001,
    }),
    []
  );

  const subjectIdTrim = subjectId.trim();
  const isBusy = status === "camera-starting" || status === "pressing" || status === "exporting";
  // Keep the button clickable even when Subject ID is missing; runSession() will show an explicit error.
  const canStartSession = !isBusy && (status === "ready" || status === "idle");

  const startCamera = async () => {
    setError(null);
    setMessage("Starting camera...");
    setStatus("camera-starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "user" },
          width: { ideal: 1920, min: 1280 },
          height: { ideal: 1080, min: 720 },
          frameRate: { ideal: 30, min: 15 },
        },
        audio: false,
      });
      streamRef.current = stream;
      const v = videoRef.current;
      if (!v) throw new Error("videoRef missing");
      v.srcObject = stream;
      await v.play();
      setStatus("ready");
      setMessage("Camera ready. Starting hand tracking...");
      return true;
    } catch (e: unknown) {
      setStatus("error");
      setError(toErrorMessage(e));
      setMessage("Failed to start camera.");
      return false;
    }
  };

  const stopAll = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (handsRef.current) {
      try {
        handsRef.current.close();
      } catch {}
      handsRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    latestTipRef.current = null;
    latestHandConfidenceRef.current = null;
    setTipForUI(null);
    setIsHandTracking(false);
  };

  const startHandTracking = async () => {
    try {
      await loadScriptOnce("https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js");
      const HandsCtor = (window as unknown as { Hands?: new (opts: { locateFile: (file: string) => string }) => MediaPipeHands }).Hands;
      if (!HandsCtor) throw new Error("Failed to load MediaPipe Hands.");
      const hands = new HandsCtor({
        locateFile: (file: string) =>
          `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
      });
      hands.setOptions({
        maxNumHands: 1,
        modelComplexity: 1,
        minDetectionConfidence: 0.8,
        minTrackingConfidence: 0.8,
        selfieMode: false,
        staticImageMode: false,
      });
      hands.onResults((results: HandsResults) => {
        latestHandConfidenceRef.current = extractHandConfidence(results);
        const lm = results?.multiHandLandmarks?.[0];
        const tip = lm?.[8]; // index fingertip
        if (!tip || typeof tip.x !== "number" || typeof tip.y !== "number") {
          latestTipRef.current = null;
          latestHandConfidenceRef.current = null;
          setIsHandTracking(false);
          setTipForUI(null);
          return;
        }
        const now = Date.now();
        const u0 = clamp(tip.x, 0, 1);
        const v0 = clamp(tip.y, 0, 1);
        // MediaPipe fingertip tends to drift low near the bottom; compensate upward proportionally.
        const v = clamp(v0 * (1 - config.tipVCompensation), 0, 1);
        const tipUv: TipUV = { u: u0, v, t: now };
        latestTipRef.current = tipUv;
        setIsHandTracking(true);

        const overlay = overlayRef.current;
        const video = videoRef.current;
        if (overlay && video && video.videoWidth > 0 && video.videoHeight > 0) {
          // Video is rendered with object-cover; map (u,v) to the actual on-screen position.
          const cw = overlay.clientWidth;
          const ch = overlay.clientHeight;
          const vw = video.videoWidth;
          const vh = video.videoHeight;
          if (cw > 0 && ch > 0 && vw > 0 && vh > 0) {
            const scale = Math.max(cw / vw, ch / vh);
            const dw = vw * scale;
            const dh = vh * scale;
            const ox = (cw - dw) / 2;
            const oy = (ch - dh) / 2;
            const x = u0 * dw + ox;
            const yRaw = v * dh + oy;
            // Visual micro-adjust near the bottom (UI only).
            const y = yRaw - 0.02 * v0 * ch;
            setTipForUI({ x, y });
          }
        }
      });

      handsRef.current = hands;

      let lastFrameTime = 0;
      const targetFPS = 30;
      const frameInterval = 1000 / targetFPS;

      const loop = async (t: number) => {
        const video = videoRef.current;
        if (video && video.readyState >= 2 && handsRef.current) {
          if (t - lastFrameTime >= frameInterval) {
            try {
              await handsRef.current.send({ image: video });
              lastFrameTime = t;
            } catch {
              // ignore send errors; keep loop alive
            }
          }
        }
        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
      setMessage("Hand tracking is on. Fill Subject ID, pick a label, then start a session.");
    } catch (e: unknown) {
      setStatus("error");
      setError(toErrorMessage(e));
      setMessage("Failed to initialize hand tracking.");
    }
  };

  const ensureStarted = async () => {
    if (status === "idle" || status === "error") {
      const ok = await startCamera();
      if (!ok) return false;
      await startHandTracking();
      return true;
    }
    if (status === "ready") return true;
    return false;
  };

  const captureOnePatch = async (
    frameId: number,
    sessionId: string,
    zip: JSZip,
    jsonlLines: string[]
  ) => {
    const tip = latestTipRef.current;
    const video = videoRef.current;
    if (!tip || !video || video.videoWidth <= 0 || video.videoHeight <= 0) return false;

    const cx = tip.u * video.videoWidth;
    const cy = tip.v * video.videoHeight;

    const sw = config.patchInputSizePx;
    const sh = config.patchInputSizePx;
    const half = sw / 2;
    const sx = clamp(Math.round(cx - half), 0, Math.max(0, video.videoWidth - sw));
    const sy = clamp(Math.round(cy - half), 0, Math.max(0, video.videoHeight - sh));

    let out = patchCanvasRef.current;
    if (!out) {
      out = document.createElement("canvas");
      patchCanvasRef.current = out;
    }
    out.width = config.patchOutputSizePx;
    out.height = config.patchOutputSizePx;
    const ctx = out.getContext("2d");
    if (!ctx) return false;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(
      video,
      sx,
      sy,
      sw,
      sh,
      0,
      0,
      config.patchOutputSizePx,
      config.patchOutputSizePx
    );

    const blob = await canvasToJpegBlob(out, config.jpegQuality);
    const filename = `patches/${sessionId}-${String(frameId).padStart(6, "0")}.jpg`;
    zip.file(filename, blob);

    const record: JsonlPatchRecord = {
      label,
      subject_id: subjectIdTrim,
      session_id: sessionId,
      timestamp: Date.now(),
      frame_id: frameId,
      mediapipe_hand_confidence: latestHandConfidenceRef.current,
      fingertip_xy: [Math.round(cx), Math.round(cy)],
      roi_bbox: { x: sx, y: sy, w: sw, h: sh },
      ...(lightingTag.trim() ? { lighting_tag: lightingTag.trim() } : {}),
      ...(deviceTag.trim() ? { device_tag: deviceTag.trim() } : {}),
    };
    jsonlLines.push(JSON.stringify(record));
    return true;
  };

  const runSession = async () => {
    setError(null);
    setCapturedCount(0);

    if (!subjectIdTrim) {
      setStatus("ready");
      setError("Subject ID is required.");
      setMessage("Please enter Subject ID before starting.");
      return;
    }

    const ok = await ensureStarted();
    if (!ok) return;

    const video = videoRef.current;
    if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) {
      setStatus("error");
      setError("Video is not ready (videoWidth/videoHeight is 0).");
      return;
    }

    const sessionId = makeSessionId(label);
    const startedAt = Date.now();

    setStatus("pressing");
    setMessage(
      `Capture running for ${msToText(config.pressDurationMs)} (auto-capture at ${config.samplingHz}Hz).`
    );

    const zip = datasetZipRef.current;
    const jsonlLines: string[] = [];
    const intervalMs = Math.round(1000 / config.samplingHz);
    const endAt = startedAt + config.pressDurationMs;
    let frameId = 0;

    while (Date.now() < endAt) {
      await new Promise((r) => setTimeout(r, intervalMs));
      const nextId = frameId + 1;
      const saved = await captureOnePatch(nextId, sessionId, zip, jsonlLines);
      if (saved) {
        frameId = nextId;
        setCapturedCount((c) => c + 1);
        setDatasetPatchCount((c) => c + 1);
      }
    }

    setStatus("ready");
    if (jsonlLines.length <= 0) {
      setError("No patches captured. Make sure the fingertip is detected.");
      setMessage("Nothing was added to the dataset buffer.");
      return;
    }

    const jsonl = `${jsonlLines.join("\n")}\n`;
    zip.file(`sessions/${sessionId}.jsonl`, jsonl);
    datasetJsonlLinesRef.current.push(...jsonlLines);
    datasetSessionIdsRef.current = [...datasetSessionIdsRef.current, sessionId];
    setDatasetSessionCount(datasetSessionIdsRef.current.length);
    setMessage(
      `Session buffered (${jsonlLines.length} patches). Capture more sessions, then download the dataset zip when ready.`
    );
  };

  const downloadDatasetZip = async () => {
    setError(null);
    if (datasetPatchCount <= 0) {
      setError("No patches in buffer yet.");
      setMessage("Capture at least one session before downloading.");
      return;
    }
    setStatus("exporting");
    setMessage("Packaging and downloading dataset zip...");
    try {
      const zip = datasetZipRef.current;
      const datasetId = datasetIdRef.current;
      const jsonlAll =
        datasetJsonlLinesRef.current.length > 0
          ? `${datasetJsonlLinesRef.current.join("\n")}\n`
          : "";
      zip.file(`${datasetId}.jsonl`, jsonlAll);
      zip.file(
        `${datasetId}.manifest.json`,
        JSON.stringify(
          {
            dataset_id: datasetId,
            created_at: Date.now(),
            sessions: datasetSessionIdsRef.current,
            patches: datasetPatchCount,
            schema: "jsonl-per-patch + sessions/{session_id}.jsonl",
          },
          null,
          2
        )
      );

      const zipBlob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${datasetId}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus("ready");
      setMessage("Dataset zip downloaded.");
    } catch (e: unknown) {
      setStatus("error");
      setError(toErrorMessage(e));
      setMessage("Failed to export dataset zip.");
    }
  };

  const clearDatasetBuffer = () => {
    datasetIdRef.current = makeDatasetId();
    datasetZipRef.current = new JSZip();
    datasetJsonlLinesRef.current = [];
    datasetSessionIdsRef.current = [];
    setDatasetSessionCount(0);
    setDatasetPatchCount(0);
    setMessage("Dataset buffer cleared.");
    setError(null);
  };

  useEffect(() => {
    // auto-start camera + tracking for convenience
    void (async () => {
      await ensureStarted();
    })();
    return () => stopAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen bg-white text-gray-900">
      <div className="mx-auto max-w-5xl px-4 py-4 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col">
            <div className="text-lg font-semibold">Pressure Patch Collector (for MobileNet training)</div>
            <div className="text-xs text-gray-600">
              Flow: enter Subject ID → choose label → press ~3s → auto-save patches at 5Hz during stable segments → download zip (images + JSONL)
            </div>
          </div>
          <Link
            href="/"
            className="text-xs px-3 py-1 rounded border border-gray-200 hover:bg-gray-50"
          >
            Back to Home
          </Link>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-[1fr_320px] gap-3">
          <div className="relative rounded-lg border border-gray-200 overflow-hidden bg-black h-[520px]">
            <video
              ref={videoRef}
              className="absolute inset-0 w-full h-full object-cover"
              playsInline
              muted
              autoPlay
            />
            <div ref={overlayRef} className="absolute inset-0 pointer-events-none">
              {tipForUI && (
                <div
                  className="absolute w-4 h-4 -ml-2 -mt-2 rounded-full border-2 border-lime-400"
                  style={{ left: tipForUI.x, top: tipForUI.y }}
                />
              )}
              <div className="absolute left-2 top-2 text-[11px] text-white/90 bg-black/50 px-2 py-1 rounded">
                {isHandTracking ? "Hand: detected" : "Hand: missing"}
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-gray-200 p-3 flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <div className="text-sm font-medium">Subject / Tags</div>
              <label className="text-[11px] text-gray-600">Subject ID (required)</label>
              <input
                value={subjectId}
                onChange={(e) => setSubjectId(e.target.value)}
                className="px-2 py-1.5 text-sm border border-gray-200 rounded"
                placeholder="e.g., S001"
                disabled={status === "pressing" || status === "exporting"}
              />
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1">
                  <label className="text-[11px] text-gray-600">Lighting tag (optional)</label>
                  <input
                    value={lightingTag}
                    onChange={(e) => setLightingTag(e.target.value)}
                    className="px-2 py-1.5 text-sm border border-gray-200 rounded"
                    placeholder="e.g., office / dim / sunlight"
                    disabled={status === "pressing" || status === "exporting"}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[11px] text-gray-600">Device tag (optional)</label>
                  <input
                    value={deviceTag}
                    onChange={(e) => setDeviceTag(e.target.value)}
                    className="px-2 py-1.5 text-sm border border-gray-200 rounded"
                    placeholder="e.g., iPhone15 / Pixel8"
                    disabled={status === "pressing" || status === "exporting"}
                  />
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <div className="text-sm font-medium">Label</div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setLabel("no_press")}
                  className={`px-3 py-1.5 rounded text-sm border ${
                    label === "no_press"
                      ? "bg-blue-600 text-white border-blue-600"
                      : "bg-white hover:bg-gray-50 border-gray-200"
                  }`}
                  disabled={status === "pressing" || status === "exporting"}
                >
                  no_press
                </button>
                <button
                  type="button"
                  onClick={() => setLabel("light")}
                  className={`px-3 py-1.5 rounded text-sm border ${
                    label === "light"
                      ? "bg-blue-600 text-white border-blue-600"
                      : "bg-white hover:bg-gray-50 border-gray-200"
                  }`}
                  disabled={status === "pressing" || status === "exporting"}
                >
                  light
                </button>
                <button
                  type="button"
                  onClick={() => setLabel("firm")}
                  className={`px-3 py-1.5 rounded text-sm border ${
                    label === "firm"
                      ? "bg-blue-600 text-white border-blue-600"
                      : "bg-white hover:bg-gray-50 border-gray-200"
                  }`}
                  disabled={status === "pressing" || status === "exporting"}
                >
                  firm
                </button>
              </div>
              <div className="text-[11px] text-gray-600">
                Current label: <span className="font-semibold">{label}</span>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <div className="text-sm font-medium">Short session capture</div>
              <button
                type="button"
                onClick={() => void runSession()}
                disabled={
                  !canStartSession
                }
                className={`px-3 py-2 rounded text-sm font-medium ${
                  status === "pressing"
                    ? "bg-gray-300 text-gray-600"
                    : "bg-emerald-600 text-white hover:bg-emerald-700"
                }`}
              >
                {status === "pressing"
                  ? "Capturing..."
                  : status === "exporting"
                    ? "Exporting..."
                    : `Start (${msToText(config.pressDurationMs)}, ${config.samplingHz}Hz)`}
              </button>

              <div className="text-[11px] text-gray-700">
                Saved patches: <span className="font-semibold">{capturedCount}</span>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <div className="text-sm font-medium">Dataset buffer</div>
              <div className="text-[11px] text-gray-700">
                Sessions buffered: <span className="font-semibold">{datasetSessionCount}</span>
                {" · "}
                Patches buffered: <span className="font-semibold">{datasetPatchCount}</span>
              </div>
              <button
                type="button"
                onClick={() => void downloadDatasetZip()}
                disabled={isBusy || datasetPatchCount <= 0}
                className="px-3 py-2 rounded text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-gray-300 disabled:text-gray-600"
              >
                Download dataset zip
              </button>
              <button
                type="button"
                onClick={clearDatasetBuffer}
                disabled={isBusy || (datasetPatchCount <= 0 && datasetSessionCount <= 0)}
                className="text-xs px-3 py-1.5 rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-50"
              >
                Clear buffer
              </button>
            </div>

            <div className="rounded border border-gray-200 bg-gray-50 px-2 py-2 text-[11px] text-gray-700">
              <div className="font-medium mb-1">Status</div>
              <div>{message || "—"}</div>
              {error && <div className="mt-1 text-red-600">{error}</div>}
              <div className="text-gray-500">
                Patch: input {config.patchInputSizePx}px → output {config.patchOutputSizePx}px (JPEG q={config.jpegQuality})
              </div>
              <div className="text-gray-500">
                JSONL fields: label, subject_id, session_id, timestamp, frame_id, mediapipe_hand_confidence, fingertip_xy, roi_bbox (+ optional tags)
              </div>
            </div>

            <button
              type="button"
              onClick={() => {
                stopAll();
                setStatus("idle");
                setMessage("Stopped.");
              }}
              className="text-xs px-3 py-1.5 rounded border border-gray-200 hover:bg-gray-50"
            >
              Stop and release camera
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}


