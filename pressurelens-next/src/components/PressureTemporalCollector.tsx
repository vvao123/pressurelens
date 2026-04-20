"use client";

import Link from "next/link";
import JSZip from "jszip";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  canvasToBlob,
  clamp,
  downloadBlob,
  extractHandConfidence,
  isClipLabel,
  loadScriptOnce,
  makeDatasetId,
  makeSessionId,
  msToText,
  pickRecorderMimeType,
  sleep,
  toErrorMessage,
  type HandsResults,
  type MediaPipeHands,
  type PressureDatasetManifest,
  type PressureLabel,
  type PressurePatchRecord,
  type PressureSessionSummary,
  type TipUV,
} from "@/lib/pressureDataset/shared";

type CollectorConfig = {
  sequenceHz: number;
  sessionDurationMs: number;
  patchInputSizePx: number;
  patchOutputSizePx: number;
  jpegQuality: number;
  tipVCompensation: number;
};

type ActiveClipRecorder = {
  mimeType: string | null;
  stop: () => Promise<Blob | null>;
};

const LABEL_ORDER: PressureLabel[] = ["no_press", "light", "firm"];

function formatTimestamp(ts: number) {
  return new Date(ts).toLocaleString();
}

function buildLabelCounts(summaries: PressureSessionSummary[]) {
  return summaries.reduce<Record<PressureLabel, number>>(
    (acc, session) => {
      acc[session.label] += 1;
      return acc;
    },
    { no_press: 0, light: 0, firm: 0 }
  );
}

export default function PressureTemporalCollector() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const handsRef = useRef<MediaPipeHands | null>(null);
  const rafRef = useRef<number | null>(null);

  const latestTipRef = useRef<TipUV | null>(null);
  const latestHandConfidenceRef = useRef<number | null>(null);
  const patchCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);

  const datasetIdRef = useRef<string>(makeDatasetId());
  const datasetZipRef = useRef<JSZip>(new JSZip());
  const datasetPatchLinesRef = useRef<string[]>([]);
  const datasetSessionSummariesRef = useRef<PressureSessionSummary[]>([]);

  const [label, setLabel] = useState<PressureLabel>("light");
  const [subjectId, setSubjectId] = useState<string>("");
  const [lightingTag, setLightingTag] = useState<string>("");
  const [deviceTag, setDeviceTag] = useState<string>("");
  const [status, setStatus] = useState<
    "idle" | "camera-starting" | "ready" | "capturing" | "exporting" | "error"
  >("idle");
  const [message, setMessage] = useState<string>("Preparing collector...");
  const [error, setError] = useState<string | null>(null);
  const [isHandTracking, setIsHandTracking] = useState<boolean>(false);
  const [tipForUI, setTipForUI] = useState<{ x: number; y: number } | null>(null);
  const [capturedCount, setCapturedCount] = useState<number>(0);
  const [datasetSessionCount, setDatasetSessionCount] = useState<number>(0);
  const [datasetPatchCount, setDatasetPatchCount] = useState<number>(0);
  const [datasetClipCount, setDatasetClipCount] = useState<number>(0);
  const [sessionProgress, setSessionProgress] = useState<number>(0);
  const [lastSessionSummary, setLastSessionSummary] = useState<PressureSessionSummary | null>(
    null
  );
  const [clipSupport, setClipSupport] = useState<"checking" | "ready" | "unsupported">(
    "checking"
  );

  const config: CollectorConfig = useMemo(
    () => ({
      sequenceHz: 10,
      sessionDurationMs: 3000,
      patchInputSizePx: 224,
      patchOutputSizePx: 224,
      jpegQuality: 0.92,
      tipVCompensation: 0.0001,
    }),
    []
  );

  const subjectIdTrim = subjectId.trim();
  const lightingTagTrim = lightingTag.trim();
  const deviceTagTrim = deviceTag.trim();
  const isBusy = status === "camera-starting" || status === "capturing" || status === "exporting";
  const canStartSession = !isBusy && (status === "idle" || status === "ready");

  const syncPreviewCanvas = (source: HTMLCanvasElement) => {
    const preview = previewCanvasRef.current;
    if (!preview) return;
    preview.width = source.width;
    preview.height = source.height;
    const ctx = preview.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, preview.width, preview.height);
    ctx.drawImage(source, 0, 0);
  };

  const clearPreviewCanvas = () => {
    const preview = previewCanvasRef.current;
    if (!preview) return;
    const ctx = preview.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, preview.width, preview.height);
  };

  const ensurePatchCanvas = () => {
    let canvas = patchCanvasRef.current;
    if (!canvas) {
      canvas = document.createElement("canvas");
      patchCanvasRef.current = canvas;
    }
    canvas.width = config.patchOutputSizePx;
    canvas.height = config.patchOutputSizePx;
    return canvas;
  };

  const drawCurrentPatch = () => {
    const tip = latestTipRef.current;
    const video = videoRef.current;
    if (!tip || !video || video.videoWidth <= 0 || video.videoHeight <= 0) {
      return null;
    }

    const cx = tip.u * video.videoWidth;
    const cy = tip.v * video.videoHeight;
    const sw = config.patchInputSizePx;
    const half = sw / 2;
    const sx = clamp(Math.round(cx - half), 0, Math.max(0, video.videoWidth - sw));
    const sy = clamp(Math.round(cy - half), 0, Math.max(0, video.videoHeight - sw));

    const canvas = ensurePatchCanvas();
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(video, sx, sy, sw, sw, 0, 0, canvas.width, canvas.height);
    syncPreviewCanvas(canvas);

    return { canvas, cx, cy, sx, sy, sw };
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
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    latestTipRef.current = null;
    latestHandConfidenceRef.current = null;
    setTipForUI(null);
    setIsHandTracking(false);
    clearPreviewCanvas();
  };

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
      const video = videoRef.current;
      if (!video) throw new Error("videoRef missing");
      video.srcObject = stream;
      await video.play();
      setStatus("ready");
      setMessage("Camera ready. Hand tracking is starting...");
      return true;
    } catch (cameraError: unknown) {
      setStatus("error");
      setError(toErrorMessage(cameraError));
      setMessage("Failed to start the camera.");
      return false;
    }
  };

  const startHandTracking = async () => {
    try {
      await loadScriptOnce("https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js");
      const HandsCtor = (
        window as unknown as {
          Hands?: new (opts: { locateFile: (file: string) => string }) => MediaPipeHands;
        }
      ).Hands;
      if (!HandsCtor) throw new Error("Failed to load MediaPipe Hands.");

      const hands = new HandsCtor({
        locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
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
        const tip = results.multiHandLandmarks?.[0]?.[8];
        if (!tip || typeof tip.x !== "number" || typeof tip.y !== "number") {
          latestTipRef.current = null;
          latestHandConfidenceRef.current = null;
          setIsHandTracking(false);
          setTipForUI(null);
          return;
        }
        const u0 = clamp(tip.x, 0, 1);
        const v0 = clamp(tip.y, 0, 1);
        const v = clamp(v0 * (1 - config.tipVCompensation), 0, 1);
        latestTipRef.current = { u: u0, v, t: Date.now() };
        setIsHandTracking(true);

        const overlay = overlayRef.current;
        const video = videoRef.current;
        if (!overlay || !video || video.videoWidth <= 0 || video.videoHeight <= 0) return;
        const scale = Math.max(overlay.clientWidth / video.videoWidth, overlay.clientHeight / video.videoHeight);
        const drawnWidth = video.videoWidth * scale;
        const drawnHeight = video.videoHeight * scale;
        const offsetX = (overlay.clientWidth - drawnWidth) / 2;
        const offsetY = (overlay.clientHeight - drawnHeight) / 2;
        setTipForUI({
          x: u0 * drawnWidth + offsetX,
          y: v * drawnHeight + offsetY - 0.02 * v0 * overlay.clientHeight,
        });
      });

      handsRef.current = hands;
      let lastFrameTime = 0;
      const frameInterval = 1000 / 30;
      const loop = async (time: number) => {
        const video = videoRef.current;
        if (video && video.readyState >= 2 && handsRef.current && time - lastFrameTime >= frameInterval) {
          try {
            await handsRef.current.send({ image: video });
            lastFrameTime = time;
          } catch {}
        }
        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
      setStatus("ready");
      setMessage("Hand tracking is on. Choose a label and start a 3s capture.");
    } catch (trackingError: unknown) {
      setStatus("error");
      setError(toErrorMessage(trackingError));
      setMessage("Failed to initialize hand tracking.");
    }
  };

  const ensureStarted = async () => {
    if (status === "idle" || status === "error") {
      const started = await startCamera();
      if (!started) return false;
      await startHandTracking();
      return true;
    }
    return status === "ready";
  };

  const startPatchClipRecorder = (canvas: HTMLCanvasElement, fps: number): ActiveClipRecorder | null => {
    if (typeof MediaRecorder === "undefined") return null;
    if (typeof canvas.captureStream !== "function") return null;

    const mimeType = pickRecorderMimeType();
    const stream = canvas.captureStream(fps);
    const chunks: Blob[] = [];

    try {
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      const stopPromise = new Promise<Blob | null>((resolve) => {
        const finish = () => {
          stream.getTracks().forEach((track) => track.stop());
          if (chunks.length <= 0) {
            resolve(null);
            return;
          }
          resolve(new Blob(chunks, { type: mimeType ?? chunks[0].type ?? "video/webm" }));
        };

        recorder.addEventListener("dataavailable", (event) => {
          if (event.data && event.data.size > 0) chunks.push(event.data);
        });
        recorder.addEventListener("stop", finish, { once: true });
        recorder.addEventListener("error", finish, { once: true });
      });

      recorder.start(200);
      return {
        mimeType,
        stop: async () => {
          if (recorder.state !== "inactive") recorder.stop();
          return await stopPromise;
        },
      };
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      return null;
    }
  };

  const captureOneFrame = async (
    sessionId: string,
    sessionLabel: PressureLabel,
    frameId: number,
    startedAt: number,
    jsonlLines: string[],
    patchPaths: string[]
  ) => {
    const patch = drawCurrentPatch();
    if (!patch) return false;

    const patchPath = `patches/${sessionId}/${String(frameId).padStart(6, "0")}.jpg`;
    const blob = await canvasToBlob(patch.canvas, "image/jpeg", config.jpegQuality);
    datasetZipRef.current.file(patchPath, blob);
    patchPaths.push(patchPath);

    const now = Date.now();
    const record: PressurePatchRecord = {
      dataset_id: datasetIdRef.current,
      label: sessionLabel,
      subject_id: subjectIdTrim,
      session_id: sessionId,
      timestamp: now,
      elapsed_ms: now - startedAt,
      frame_id: frameId,
      patch_path: patchPath,
      mediapipe_hand_confidence: latestHandConfidenceRef.current,
      fingertip_xy: [Math.round(patch.cx), Math.round(patch.cy)],
      roi_bbox: { x: patch.sx, y: patch.sy, w: patch.sw, h: patch.sw },
      runtime_input_mode: "raw_video_fingertip_crop",
      ...(lightingTagTrim ? { lighting_tag: lightingTagTrim } : {}),
      ...(deviceTagTrim ? { device_tag: deviceTagTrim } : {}),
    };
    jsonlLines.push(JSON.stringify(record));
    return true;
  };

  const runSession = async () => {
    setError(null);
    setCapturedCount(0);
    setSessionProgress(0);

    if (!subjectIdTrim) {
      setStatus("ready");
      setError("Subject ID is required.");
      setMessage("Please enter Subject ID before starting.");
      return;
    }

    const started = await ensureStarted();
    if (!started) return;

    const video = videoRef.current;
    if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) {
      setStatus("error");
      setError("Video is not ready yet.");
      setMessage("Wait for the camera preview, then try again.");
      return;
    }

    const sessionId = makeSessionId(label);
    const startedAt = Date.now();
    const intervalMs = Math.round(1000 / config.sequenceHz);
    const targetFrames = Math.max(1, Math.floor(config.sessionDurationMs / intervalMs));
    const patchPaths: string[] = [];
    const jsonlLines: string[] = [];
    const clipExpected = isClipLabel(label);

    setStatus("capturing");
    setMessage(
      clipExpected
        ? `Capturing ${targetFrames} patches at ${config.sequenceHz}Hz plus a short patch clip.`
        : `Capturing ${targetFrames} patches at ${config.sequenceHz}Hz.`
    );

    let clipRecorder: ActiveClipRecorder | null = null;
    let clipBlob: Blob | null = null;
    let clipPath: string | null = null;
    let clipMimeType: string | null = null;

    try {
      if (clipExpected) {
        clipRecorder = startPatchClipRecorder(ensurePatchCanvas(), config.sequenceHz);
        clipMimeType = clipRecorder?.mimeType ?? null;
      }

      for (let frameId = 1; frameId <= targetFrames; frameId += 1) {
        const nextCaptureAt = startedAt + frameId * intervalMs;
        await sleep(Math.max(0, nextCaptureAt - Date.now()));
        const saved = await captureOneFrame(sessionId, label, frameId, startedAt, jsonlLines, patchPaths);
        if (saved) {
          setCapturedCount((count) => count + 1);
          setDatasetPatchCount((count) => count + 1);
        }
        setSessionProgress(frameId / targetFrames);
      }
    } catch (sessionError: unknown) {
      setStatus("error");
      setError(toErrorMessage(sessionError));
      setMessage("Capture failed before the session could finish.");
      return;
    } finally {
      if (clipRecorder) {
        clipBlob = await clipRecorder.stop();
        if (clipBlob) {
          clipPath = `clips/${sessionId}.webm`;
          datasetZipRef.current.file(clipPath, clipBlob);
        }
      }
    }

    if (jsonlLines.length <= 0) {
      setStatus("ready");
      setError("No patches were captured. Keep the fingertip visible and try again.");
      setMessage("Nothing was added to the dataset buffer.");
      setSessionProgress(0);
      return;
    }

    const endedAt = Date.now();
    const sessionSummary: PressureSessionSummary = {
      dataset_id: datasetIdRef.current,
      session_id: sessionId,
      label,
      subject_id: subjectIdTrim,
      started_at: startedAt,
      ended_at: endedAt,
      duration_ms: endedAt - startedAt,
      frame_count: patchPaths.length,
      sequence_hz: config.sequenceHz,
      patch_input_size_px: config.patchInputSizePx,
      patch_output_size_px: config.patchOutputSizePx,
      runtime_input_mode: "raw_video_fingertip_crop",
      clip_expected: clipExpected,
      clip_saved: Boolean(clipPath),
      clip_path: clipPath,
      clip_mime_type: clipPath ? clipMimeType ?? clipBlob?.type ?? "video/webm" : null,
      patch_paths: patchPaths,
      ...(lightingTagTrim ? { lighting_tag: lightingTagTrim } : {}),
      ...(deviceTagTrim ? { device_tag: deviceTagTrim } : {}),
    };

    datasetPatchLinesRef.current.push(...jsonlLines);
    datasetSessionSummariesRef.current = [...datasetSessionSummariesRef.current, sessionSummary];
    datasetZipRef.current.file(`sessions/${sessionId}.jsonl`, `${jsonlLines.join("\n")}\n`);
    datasetZipRef.current.file(`sessions/${sessionId}.json`, JSON.stringify(sessionSummary, null, 2));

    setDatasetSessionCount(datasetSessionSummariesRef.current.length);
    if (clipPath) setDatasetClipCount((count) => count + 1);
    setLastSessionSummary(sessionSummary);
    setStatus("ready");
    setSessionProgress(1);
    setMessage(
      clipExpected && !clipPath
        ? "Session buffered. Patch sequence saved; this browser skipped clip recording, so the zip contains sequence frames only."
        : "Session buffered. Keep collecting more sessions, then download the dataset zip."
    );
  };

  const downloadDatasetZip = async () => {
    setError(null);
    if (datasetPatchCount <= 0) {
      setError("Capture at least one session before downloading.");
      setMessage("No sequence frames are buffered yet.");
      return;
    }

    setStatus("exporting");
    setMessage("Packaging the temporal dataset zip...");

    try {
      const summaries = datasetSessionSummariesRef.current;
      const manifest: PressureDatasetManifest = {
        dataset_id: datasetIdRef.current,
        created_at: Date.now(),
        schema_version: "pressure-temporal-v1",
        runtime_input_mode: "raw_video_fingertip_crop",
        session_ids: summaries.map((session) => session.session_id),
        session_count: summaries.length,
        patch_count: datasetPatchCount,
        clip_count: datasetClipCount,
        sequence_hz: config.sequenceHz,
        session_duration_ms: config.sessionDurationMs,
        label_counts: buildLabelCounts(summaries),
        files: {
          manifest: "dataset.manifest.json",
          sessions_dir: "sessions",
          patches_dir: "patches",
          clips_dir: "clips",
          annotations_dir: "annotations",
        },
      };

      datasetZipRef.current.file("dataset.manifest.json", JSON.stringify(manifest, null, 2));
      datasetZipRef.current.file(`${datasetIdRef.current}.jsonl`, `${datasetPatchLinesRef.current.join("\n")}\n`);
      datasetZipRef.current.file("sessions/index.json", JSON.stringify(summaries, null, 2));
      datasetZipRef.current.file("annotations/README.txt", "Use /annotate-pressure to review session clips and export labels.\n");

      const blob = await datasetZipRef.current.generateAsync({ type: "blob" });
      downloadBlob(blob, `${datasetIdRef.current}.zip`);
      setStatus("ready");
      setMessage("Dataset zip downloaded.");
    } catch (exportError: unknown) {
      setStatus("error");
      setError(toErrorMessage(exportError));
      setMessage("Failed to export the dataset zip.");
    }
  };

  const clearDatasetBuffer = () => {
    datasetIdRef.current = makeDatasetId();
    datasetZipRef.current = new JSZip();
    datasetPatchLinesRef.current = [];
    datasetSessionSummariesRef.current = [];
    setDatasetSessionCount(0);
    setDatasetPatchCount(0);
    setDatasetClipCount(0);
    setCapturedCount(0);
    setSessionProgress(0);
    setLastSessionSummary(null);
    clearPreviewCanvas();
    setError(null);
    setMessage("Dataset buffer cleared.");
  };

  useEffect(() => {
    const hasCaptureStream =
      typeof HTMLCanvasElement !== "undefined" &&
      typeof HTMLCanvasElement.prototype.captureStream === "function";
    setClipSupport(
      typeof MediaRecorder !== "undefined" && hasCaptureStream ? "ready" : "unsupported"
    );
  }, []);

  useEffect(() => {
    void (async () => {
      await ensureStarted();
    })();
    return () => {
      stopAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,#fef3c7,0%,#fff7ed,32%,#ffffff,75%)] text-slate-900">
      <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-5">
        <div className="rounded-[28px] border border-amber-200/70 bg-white/85 p-5 shadow-[0_20px_80px_rgba(120,53,15,0.08)] backdrop-blur">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="max-w-3xl">
              <div className="text-sm font-semibold uppercase tracking-[0.24em] text-amber-700">
                Pressure Temporal Collector
              </div>
              <h1 className="mt-1 text-2xl font-semibold text-slate-900">
                Runtime-aligned sequence capture
              </h1>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                All labels save a {config.sequenceHz}Hz fingertip-centered image sequence from the raw
                camera input. <span className="font-medium text-slate-800">light</span> and{" "}
                <span className="font-medium text-slate-800">firm</span> also attempt to save a short
                patch clip for later annotation, so we keep temporal information without forcing the
                product to ship a heavy full-video model.
              </p>
            </div>
            <div className="flex gap-2">
              <Link
                href="/annotate-pressure"
                className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-300 hover:bg-slate-50"
              >
                Open Annotator
              </Link>
              <Link
                href="/"
                className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-300 hover:bg-slate-50"
              >
                Back Home
              </Link>
            </div>
          </div>
          <div className="mt-3 grid gap-2 text-xs text-slate-600 md:grid-cols-3">
            <div className="rounded-2xl border border-amber-200/80 bg-amber-50 px-3 py-2">
              Input mode: raw hidden video + fingertip crop
            </div>
            <div className="rounded-2xl border border-emerald-200/80 bg-emerald-50 px-3 py-2">
              Sequence: {config.sequenceHz}Hz for {msToText(config.sessionDurationMs)}
            </div>
            <div className="rounded-2xl border border-sky-200/80 bg-sky-50 px-3 py-2">
              Clip support: {clipSupport === "ready" ? "available for light / firm" : "sequence fallback only"}
            </div>
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_420px]">
          <div className="relative overflow-hidden rounded-[30px] border border-slate-200/70 bg-black shadow-[0_30px_90px_rgba(15,23,42,0.35)]">
            <div className="relative aspect-[4/3] min-h-[420px] w-full">
              <video
                ref={videoRef}
                className="absolute inset-0 h-full w-full object-cover"
                autoPlay
                muted
                playsInline
              />
              <div ref={overlayRef} className="pointer-events-none absolute inset-0">
                {tipForUI && (
                  <div
                    className="absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-lime-300 bg-lime-300/20 shadow-[0_0_24px_rgba(163,230,53,0.65)]"
                    style={{ left: tipForUI.x, top: tipForUI.y }}
                  />
                )}

                <div className="absolute left-4 top-4 rounded-full border border-white/15 bg-black/45 px-3 py-1.5 text-[11px] uppercase tracking-[0.22em] text-white/80 backdrop-blur">
                  {isHandTracking ? "Hand detected" : "Hand missing"}
                </div>

                <div className="absolute bottom-4 left-4 w-[210px] rounded-2xl border border-white/15 bg-black/55 p-3 text-white backdrop-blur-sm">
                  <div className="text-[10px] uppercase tracking-[0.22em] text-white/60">
                    Patch Preview
                  </div>
                  <canvas
                    ref={previewCanvasRef}
                    width={224}
                    height={224}
                    className="mt-2 block h-[156px] w-[156px] rounded-xl border border-white/15 bg-black"
                  />
                  <div className="mt-2 text-[11px] text-white/65">224 x 224 crop</div>
                </div>

                <div className="absolute bottom-4 right-4 w-[240px] rounded-2xl border border-white/15 bg-black/55 p-3 text-white backdrop-blur-sm">
                  <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.22em] text-white/60">
                    <span>Session</span>
                    <span>{Math.round(sessionProgress * 100)}%</span>
                  </div>
                  <div className="mt-2 h-2 rounded-full bg-white/10">
                    <div
                      className="h-full rounded-full bg-amber-300 transition-[width] duration-150"
                      style={{ width: `${Math.round(sessionProgress * 100)}%` }}
                    />
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-center text-[11px]">
                    <div className="rounded-xl border border-white/10 bg-white/5 px-2 py-2">
                      <div className="text-white/50">Frames</div>
                      <div className="mt-1 text-base font-semibold">{capturedCount}</div>
                    </div>
                    <div className="rounded-xl border border-white/10 bg-white/5 px-2 py-2">
                      <div className="text-white/50">Label</div>
                      <div className="mt-1 text-sm font-semibold">{label}</div>
                    </div>
                    <div className="rounded-xl border border-white/10 bg-white/5 px-2 py-2">
                      <div className="text-white/50">Clip</div>
                      <div className="mt-1 text-sm font-semibold">{isClipLabel(label) ? "On" : "Off"}</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <div className="rounded-[28px] border border-slate-200/80 bg-white/88 p-4 shadow-[0_20px_80px_rgba(15,23,42,0.08)] backdrop-blur">
              <div className="text-sm font-semibold text-slate-900">Subject And Tags</div>
              <div className="mt-3 flex flex-col gap-3">
                <input
                  value={subjectId}
                  onChange={(event) => setSubjectId(event.target.value)}
                  disabled={isBusy}
                  placeholder="Subject ID, e.g. S001"
                  className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-amber-300"
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  <input
                    value={lightingTag}
                    onChange={(event) => setLightingTag(event.target.value)}
                    disabled={isBusy}
                    placeholder="Lighting tag"
                    className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-amber-300"
                  />
                  <input
                    value={deviceTag}
                    onChange={(event) => setDeviceTag(event.target.value)}
                    disabled={isBusy}
                    placeholder="Device tag"
                    className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-amber-300"
                  />
                </div>
              </div>
            </div>

            <div className="rounded-[28px] border border-slate-200/80 bg-white/88 p-4 shadow-[0_20px_80px_rgba(15,23,42,0.08)] backdrop-blur">
              <div className="text-sm font-semibold text-slate-900">Label And Capture</div>
              <div className="mt-3 flex flex-wrap gap-2">
                {LABEL_ORDER.map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setLabel(option)}
                    disabled={isBusy}
                    className={`rounded-full border px-4 py-2 text-sm font-medium ${
                      label === option
                        ? "border-amber-400 bg-amber-400 text-slate-950"
                        : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50"
                    }`}
                  >
                    {option}
                  </button>
                ))}
              </div>
              <div className="mt-3 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                {label === "no_press"
                  ? "no_press stores only the sequence frames."
                  : `${label} stores sequence frames and tries to save a short patch clip for annotation.`}
              </div>
              <button
                type="button"
                onClick={() => void runSession()}
                disabled={!canStartSession}
                className={`mt-4 w-full rounded-2xl px-4 py-3 text-sm font-semibold ${
                  status === "capturing"
                    ? "bg-slate-300 text-slate-600"
                    : "bg-emerald-600 text-white hover:bg-emerald-700"
                }`}
              >
                {status === "capturing" ? "Capturing..." : `Start ${msToText(config.sessionDurationMs)} Session`}
              </button>
            </div>

            <div className="rounded-[28px] border border-slate-200/80 bg-white/88 p-4 shadow-[0_20px_80px_rgba(15,23,42,0.08)] backdrop-blur">
              <div className="text-sm font-semibold text-slate-900">Dataset Buffer</div>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3">
                  <div className="text-xs uppercase tracking-[0.18em] text-slate-500">Sessions</div>
                  <div className="mt-1 text-2xl font-semibold text-slate-900">{datasetSessionCount}</div>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3">
                  <div className="text-xs uppercase tracking-[0.18em] text-slate-500">Patches</div>
                  <div className="mt-1 text-2xl font-semibold text-slate-900">{datasetPatchCount}</div>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3">
                  <div className="text-xs uppercase tracking-[0.18em] text-slate-500">Clips</div>
                  <div className="mt-1 text-2xl font-semibold text-slate-900">{datasetClipCount}</div>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void downloadDatasetZip()}
                  disabled={isBusy || datasetPatchCount <= 0}
                  className="rounded-full bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:bg-slate-300 disabled:text-slate-600"
                >
                  Download Dataset Zip
                </button>
                <button
                  type="button"
                  onClick={clearDatasetBuffer}
                  disabled={isBusy || (datasetSessionCount <= 0 && datasetPatchCount <= 0)}
                  className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-300 hover:bg-slate-50 disabled:opacity-50"
                >
                  Clear Buffer
                </button>
                <button
                  type="button"
                  onClick={() => {
                    stopAll();
                    setStatus("idle");
                    setMessage("Stopped and released the camera.");
                  }}
                  className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-300 hover:bg-slate-50"
                >
                  Stop Camera
                </button>
              </div>
            </div>

            <div className="rounded-[28px] border border-slate-200/80 bg-white/88 p-4 shadow-[0_20px_80px_rgba(15,23,42,0.08)] backdrop-blur">
              <div className="text-sm font-semibold text-slate-900">Status</div>
              <div className="mt-3 space-y-2 text-sm text-slate-600">
                <p>{message}</p>
                {error && <p className="rounded-2xl border border-red-200 bg-red-50 px-3 py-2 text-red-700">{error}</p>}
                <p className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                  Recommended training path: start with the 10Hz sequence as the main signal, then use the saved clips for review,
                  relabeling, or a lightweight temporal head. That is usually cheaper at runtime than a true video model.
                </p>
              </div>
            </div>

            {lastSessionSummary && (
              <div className="rounded-[28px] border border-slate-200/80 bg-white/88 p-4 shadow-[0_20px_80px_rgba(15,23,42,0.08)] backdrop-blur">
                <div className="text-sm font-semibold text-slate-900">Last Session</div>
                <div className="mt-3 space-y-2 text-sm text-slate-600">
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2">
                    {lastSessionSummary.label} · {lastSessionSummary.frame_count} frames ·{" "}
                    {lastSessionSummary.clip_saved ? "clip saved" : lastSessionSummary.clip_expected ? "sequence only" : "no clip"}
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2">
                    Subject {lastSessionSummary.subject_id} · {formatTimestamp(lastSessionSummary.started_at)}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
