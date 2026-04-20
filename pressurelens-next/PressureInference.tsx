"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";

// ─── Types (mirrored from collector) ──────────────────
type TipUV = { u: number; v: number };

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

// ─── ONNX runtime type (loaded dynamically) ───────────
type OrtSession = {
  run: (feeds: Record<string, OrtTensor>) => Promise<Record<string, OrtTensor>>;
};
type OrtTensor = {
  data: Float32Array;
  dims: number[];
};
type OrtStatic = {
  InferenceSession: {
    create: (path: string) => Promise<OrtSession>;
  };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => OrtTensor;
  env: { wasm: { wasmPaths: string } };
};

// ─── Constants ────────────────────────────────────────
const CLASS_NAMES = ["Firm", "Light", "NoPress"] as const;
type PredictionClass = (typeof CLASS_NAMES)[number];

const CLASS_COLORS: Record<PredictionClass, { bar: string; badge: string; glow: string }> = {
  Firm:    { bar: "bg-red-500",    badge: "bg-red-500 text-white",    glow: "shadow-red-500/60" },
  Light:   { bar: "bg-yellow-400", badge: "bg-yellow-400 text-black", glow: "shadow-yellow-400/60" },
  NoPress: { bar: "bg-emerald-500",badge: "bg-emerald-500 text-white",glow: "shadow-emerald-500/60" },
};

const IMG_SIZE = 64;
const PATCH_SIZE_PX = 224;
const INFER_HZ = 10; // run inference N times per second
const TIP_V_COMPENSATION = 0.0001;

// ─── Helpers (same as collector) ──────────────────────
function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

async function loadScriptOnce(src: string) {
  if (typeof document === "undefined") return;
  const existed = Array.from(document.scripts).some((s) => s.src === src);
  if (existed) return;
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`failed to load: ${src}`));
    document.head.appendChild(script);
  });
}

function softmax(logits: Float32Array): number[] {
  const max = Math.max(...Array.from(logits));
  const exps = Array.from(logits).map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((v) => v / sum);
}

// ImageData → normalized Float32Array in CHW format (matches PyTorch training)
function imageDataToTensor(canvas: HTMLCanvasElement): Float32Array {
  const ctx = canvas.getContext("2d")!;
  const { data } = ctx.getImageData(0, 0, IMG_SIZE, IMG_SIZE);
  const tensor = new Float32Array(3 * IMG_SIZE * IMG_SIZE);
  const mean = 0.5;
  const std = 0.5;
  for (let i = 0; i < IMG_SIZE * IMG_SIZE; i++) {
    tensor[i]                          = (data[i * 4]     / 255 - mean) / std; // R
    tensor[i + IMG_SIZE * IMG_SIZE]    = (data[i * 4 + 1] / 255 - mean) / std; // G
    tensor[i + IMG_SIZE * IMG_SIZE * 2]= (data[i * 4 + 2] / 255 - mean) / std; // B
  }
  return tensor;
}

// ─── Component ────────────────────────────────────────
export default function PressureInference() {
  const videoRef   = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const patchRef   = useRef<HTMLCanvasElement | null>(null);
  const resizeRef  = useRef<HTMLCanvasElement | null>(null);
  const streamRef  = useRef<MediaStream | null>(null);
  const handsRef   = useRef<MediaPipeHands | null>(null);
  const rafRef     = useRef<number | null>(null);
  const ortRef     = useRef<OrtSession | null>(null);
  const latestTipRef = useRef<TipUV | null>(null);
  const lastInferRef = useRef<number>(0);

  const [status, setStatus]           = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [isHandDetected, setIsHandDetected] = useState(false);
  const [tipForUI, setTipForUI]       = useState<{ x: number; y: number } | null>(null);
  const [error, setError]             = useState<string | null>(null);

  const [prediction, setPrediction]   = useState<PredictionClass | null>(null);
  const [confidences, setConfidences] = useState<Record<PredictionClass, number>>({
    Firm: 0, Light: 0, NoPress: 0,
  });
  const [inferMs, setInferMs]         = useState<number | null>(null);

  // ─── Cleanup ────────────────────────────────────────
  const stopAll = useCallback(() => {
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    if (handsRef.current) { try { handsRef.current.close(); } catch {} handsRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
    latestTipRef.current = null;
    setTipForUI(null);
    setIsHandDetected(false);
  }, []);

  // ─── Run inference on latest fingertip crop ─────────
  const runInference = useCallback(async () => {
    const tip   = latestTipRef.current;
    const video = videoRef.current;
    const ort   = ortRef.current;
    if (!tip || !video || !ort || video.videoWidth <= 0) return;

    // Get or create canvases
    if (!patchRef.current)  patchRef.current  = document.createElement("canvas");
    if (!resizeRef.current) resizeRef.current = document.createElement("canvas");

    const patch  = patchRef.current;
    const resize = resizeRef.current;

    // Crop patch around fingertip (same logic as collector)
    const cx   = tip.u * video.videoWidth;
    const cy   = tip.v * video.videoHeight;
    const half = PATCH_SIZE_PX / 2;
    const sx   = clamp(Math.round(cx - half), 0, Math.max(0, video.videoWidth  - PATCH_SIZE_PX));
    const sy   = clamp(Math.round(cy - half), 0, Math.max(0, video.videoHeight - PATCH_SIZE_PX));

    patch.width  = PATCH_SIZE_PX;
    patch.height = PATCH_SIZE_PX;
    const pCtx = patch.getContext("2d")!;
    pCtx.drawImage(video, sx, sy, PATCH_SIZE_PX, PATCH_SIZE_PX, 0, 0, PATCH_SIZE_PX, PATCH_SIZE_PX);

    // Resize to 64x64 (model input size)
    resize.width  = IMG_SIZE;
    resize.height = IMG_SIZE;
    const rCtx = resize.getContext("2d")!;
    rCtx.drawImage(patch, 0, 0, IMG_SIZE, IMG_SIZE);

    // Copy debug view to visible canvas -> FOR DEBUGGING ONLY, can be removed in production
    const debugCanvas = document.getElementById("debug-resize") as HTMLCanvasElement;
    if (debugCanvas) {
      const dCtx = debugCanvas.getContext("2d")!;
      dCtx.drawImage(resize, 0, 0, 64, 64);
}

    // Convert to tensor
    const tensorData = imageDataToTensor(resize);

    // Run ONNX inference
    const t0 = performance.now();
    try {
      const ortLib = (window as unknown as { ort?: OrtStatic }).ort;
      if (!ortLib) return;
      const inputTensor = new ortLib.Tensor("float32", tensorData, [1, 3, IMG_SIZE, IMG_SIZE]);
      const results     = await ort.run({ input: inputTensor });
      const logits      = results["output"].data as Float32Array;
      const probs       = softmax(logits);
      const predIdx     = probs.indexOf(Math.max(...probs));

      setInferMs(Math.round(performance.now() - t0));
      setPrediction(CLASS_NAMES[predIdx]);
      setConfidences({
        Firm:    probs[0],
        Light:   probs[1],
        NoPress: probs[2],
      });
    } catch (e) {
      console.error("Inference error:", e);
    }
  }, []);

  // ─── Boot: load ONNX model + camera + MediaPipe ─────
  useEffect(() => {
    let cancelled = false;

    const boot = async () => {
      setStatus("loading");
      setError(null);

      try {
        // 1. Load onnxruntime-web from CDN (no extra npm package needed)
        await loadScriptOnce(
          "https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort.min.js"
        );

        const ort = (window as unknown as { ort?: OrtStatic }).ort;
        if (!ort) throw new Error("onnxruntime-web failed to load.");

        // Point WASM to CDN
        ort.env.wasm.wasmPaths =
          "https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/";

        // 2. Load ONNX model from /public
        const session = await ort.InferenceSession.create("/pressure_cnn_postChange.onnx");
        if (cancelled) return;
        ortRef.current = session;

        // 3. Start camera
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "user" },
            width:  { ideal: 1920, min: 1280 },
            height: { ideal: 1080, min: 720 },
            frameRate: { ideal: 30, min: 15 },
          },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        const v = videoRef.current!;
        v.srcObject = stream;
        await v.play();

        // 4. Load MediaPipe Hands
        await loadScriptOnce("https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js");
        const HandsCtor = (window as unknown as { Hands?: new (opts: { locateFile: (f: string) => string }) => MediaPipeHands }).Hands;
        if (!HandsCtor) throw new Error("MediaPipe Hands failed to load.");

        const hands = new HandsCtor({
          locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
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
          const lm  = results?.multiHandLandmarks?.[0];
          const tip = lm?.[8];
          if (!tip || typeof tip.x !== "number" || typeof tip.y !== "number") {
            latestTipRef.current = null;
            setIsHandDetected(false);
            setTipForUI(null);
            setPrediction(null);
            return;
          }

          const u0 = clamp(tip.x, 0, 1);
          const v  = clamp(tip.y * (1 - TIP_V_COMPENSATION), 0, 1);
          latestTipRef.current = { u: u0, v };
          setIsHandDetected(true);

          // Map to screen coords for the dot overlay
          const overlay = overlayRef.current;
          const video   = videoRef.current;
          if (overlay && video && video.videoWidth > 0) {
            const cw = overlay.clientWidth;
            const ch = overlay.clientHeight;
            const scale = Math.max(cw / video.videoWidth, ch / video.videoHeight);
            const dw = video.videoWidth  * scale;
            const dh = video.videoHeight * scale;
            const ox = (cw - dw) / 2;
            const oy = (ch - dh) / 2;
            const x  = u0 * dw + ox;
            const y  = v   * dh + oy - 0.02 * tip.y * ch;
            setTipForUI({ x, y });
          }
        });

        handsRef.current = hands;

        // 5. RAF loop: send frames to MediaPipe + throttled inference
        let lastFrame = 0;
        const loop = async (t: number) => {
          const video = videoRef.current;
          if (video && video.readyState >= 2 && handsRef.current) {
            if (t - lastFrame >= 1000 / 30) {
              try { await handsRef.current.send({ image: video }); } catch {}
              lastFrame = t;
            }
          }
          // Throttle inference to INFER_HZ
          if (t - lastInferRef.current >= 1000 / INFER_HZ) {
            lastInferRef.current = t;
            void runInference();
          }
          rafRef.current = requestAnimationFrame(loop);
        };
        rafRef.current = requestAnimationFrame(loop);

        if (!cancelled) setStatus("ready");
      } catch (e: unknown) {
        if (!cancelled) {
          setStatus("error");
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    };

    void boot();
    return () => { cancelled = true; stopAll(); };
  }, [runInference, stopAll]);

  // ─── Derived UI values ────────────────────────────────
  const colors = prediction ? CLASS_COLORS[prediction] : null;

  return (
    
    <div className="min-h-screen bg-white text-gray-900">
      <div className="mx-auto max-w-5xl px-4 py-4 flex flex-col gap-3">

        {/* Header */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col">
            <div className="text-lg font-semibold">Pressure Inference — Live</div>
            <div className="text-xs text-gray-600">
              Point your index finger at the camera. Prediction updates at {INFER_HZ}Hz.
            </div>
          </div>
          <Link
            href="/"
            className="text-xs px-3 py-1 rounded border border-gray-200 hover:bg-gray-50"
          >
            Back to Home
          </Link>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-[1fr_300px] gap-3">

          {/* Camera + AR overlay */}
          <div className="relative rounded-lg border border-gray-200 overflow-hidden bg-black h-[520px]">
            <video
              ref={videoRef}
              className="absolute inset-0 w-full h-full object-cover"
              playsInline muted autoPlay
            />

            <div ref={overlayRef} className="absolute inset-0 pointer-events-none">

              {/* Fingertip dot */}
              {tipForUI && (
                <div
                  className="absolute w-5 h-5 -ml-2.5 -mt-2.5 rounded-full border-2 border-lime-400"
                  style={{ left: tipForUI.x, top: tipForUI.y }}
                />
              )}

              {/* Debug: show what model sees */} {/* Can be removed in production */}
              <canvas
                id="debug-resize"
                width={64}
                height={64}
                className="absolute bottom-2 left-2 border-2 border-yellow-400"
                style={{ width: 128, height: 128, imageRendering: "pixelated" }}
              />

              {/* Big prediction badge — anchored near fingertip */}
              {tipForUI && prediction && colors && (
                <div
                  className={`absolute -translate-x-1/2 -translate-y-full -mt-4 px-4 py-1.5 rounded-full text-sm font-bold shadow-lg ${colors.badge} ${colors.glow}`}
                  style={{ left: tipForUI.x, top: tipForUI.y - 16 }}
                >
                  {prediction}
                </div>
              )}

              {/* Hand status badge */}
              <div className="absolute left-2 top-2 text-[11px] text-white/90 bg-black/50 px-2 py-1 rounded">
                {isHandDetected ? "Hand: detected" : "Hand: missing"}
              </div>

              {/* Inference ms badge */}
              {inferMs !== null && (
                <div className="absolute right-2 top-2 text-[11px] text-white/90 bg-black/50 px-2 py-1 rounded">
                  {inferMs}ms
                </div>
              )}

              {/* Loading overlay */}
              {status === "loading" && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 text-white gap-2">
                  <div className="w-8 h-8 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <div className="text-sm">Loading model + camera...</div>
                </div>
              )}

              {/* Error overlay */}
              {status === "error" && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 text-white gap-2 px-6 text-center">
                  <div className="text-red-400 font-semibold">Error</div>
                  <div className="text-xs text-white/80">{error}</div>
                </div>
              )}
            </div>
          </div>

          {/* Confidence panel */}
          <div className="rounded-lg border border-gray-200 p-3 flex flex-col gap-4">

            {/* Current prediction */}
            <div className="flex flex-col gap-1">
              <div className="text-sm font-medium">Prediction</div>
              {prediction && colors ? (
                <div className={`text-2xl font-bold px-3 py-2 rounded-lg text-center ${colors.badge}`}>
                  {prediction}
                </div>
              ) : (
                <div className="text-2xl font-bold px-3 py-2 rounded-lg text-center bg-gray-100 text-gray-400">
                  —
                </div>
              )}
            </div>

            {/* Confidence bars */}
            <div className="flex flex-col gap-3">
              <div className="text-sm font-medium">Confidence</div>
              {CLASS_NAMES.map((cls) => {
                const pct  = Math.round(confidences[cls] * 100);
                const c    = CLASS_COLORS[cls];
                const isTop = cls === prediction;
                return (
                  <div key={cls} className="flex flex-col gap-1">
                    <div className="flex justify-between text-xs">
                      <span className={isTop ? "font-semibold" : "text-gray-600"}>{cls}</span>
                      <span className={isTop ? "font-semibold" : "text-gray-500"}>{pct}%</span>
                    </div>
                    <div className="h-3 rounded-full bg-gray-100 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-100 ${c.bar}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Stats */}
            <div className="rounded border border-gray-200 bg-gray-50 px-2 py-2 text-[11px] text-gray-700 flex flex-col gap-1 mt-auto">
              <div className="font-medium mb-1">Info</div>
              <div>Model: <span className="font-mono">pressure_cnn_postChange.onnx</span></div>
              <div>Input: <span className="font-mono">{IMG_SIZE}×{IMG_SIZE} RGB</span></div>
              <div>Inference: <span className="font-mono">{INFER_HZ}Hz</span></div>
              <div>Runtime: <span className="font-mono">onnxruntime-web (WebGL)</span></div>
              {inferMs !== null && (
                <div>Last inference: <span className="font-mono">{inferMs}ms</span></div>
              )}
              <div className={`mt-1 font-medium ${
                status === "ready"   ? "text-emerald-600" :
                status === "loading" ? "text-yellow-600"  :
                status === "error"   ? "text-red-600"     : "text-gray-500"
              }`}>
                {status === "ready"   ? "● Ready" :
                 status === "loading" ? "● Loading..." :
                 status === "error"   ? "● Error" : "● Idle"}
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
