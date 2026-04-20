"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

export type PressurePredictionClass = "Firm" | "Light" | "NoPress";

export type FingertipUv = {
  u: number;
  v: number;
};

type OrtTensor = {
  data: Float32Array;
  dims: number[];
};

type OrtSession = {
  run: (feeds: Record<string, OrtTensor>) => Promise<Record<string, OrtTensor>>;
  inputNames?: string[];
  outputNames?: string[];
};

type OrtStatic = {
  InferenceSession: {
    create: (path: string) => Promise<OrtSession>;
  };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => OrtTensor;
  env: { wasm: { wasmPaths: string } };
};

export type UsePressureInferenceOptions = {
  enabled: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  fingerTipUv: FingertipUv | null;
  previewCanvasRef?: RefObject<HTMLCanvasElement | null>;
  modelPath?: string;
  inferHz?: number;
};

export type UsePressureInferenceResult = {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  prediction: PressurePredictionClass | null;
  confidences: Record<PressurePredictionClass, number>;
  inferMs: number | null;
};

const CLASS_NAMES: PressurePredictionClass[] = ["Firm", "Light", "NoPress"];
const DEFAULT_MODEL_PATH = "/pressure_cnn_v1.onnx";
const DEFAULT_INFER_HZ = 10;
const IMG_SIZE = 64;
const PATCH_SIZE_PX = 224;
const ORT_SCRIPT_SRC = "https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort.min.js";
const ORT_WASM_PATH = "https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/";

let ortScriptPromise: Promise<void> | null = null;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

async function loadOrtRuntime() {
  if (typeof window === "undefined") return;
  if ((window as unknown as { ort?: OrtStatic }).ort) return;

  if (!ortScriptPromise) {
    ortScriptPromise = new Promise<void>((resolve, reject) => {
      const existing = Array.from(document.scripts).find(
        (script) => script.src === ORT_SCRIPT_SRC
      ) as HTMLScriptElement | undefined;

      if (existing) {
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener(
          "error",
          () => reject(new Error(`failed to load: ${ORT_SCRIPT_SRC}`)),
          { once: true }
        );
        return;
      }

      const script = document.createElement("script");
      script.src = ORT_SCRIPT_SRC;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () =>
        reject(new Error(`failed to load: ${ORT_SCRIPT_SRC}`));
      document.head.appendChild(script);
    });
  }

  return ortScriptPromise;
}

function softmax(logits: Float32Array): number[] {
  const values = Array.from(logits);
  const max = Math.max(...values);
  const exps = values.map((value) => Math.exp(value - max));
  const sum = exps.reduce((acc, value) => acc + value, 0);
  return exps.map((value) => value / sum);
}

function imageDataToTensor(canvas: HTMLCanvasElement): Float32Array {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Could not read model input canvas.");
  }

  const { data } = ctx.getImageData(0, 0, IMG_SIZE, IMG_SIZE);
  const tensor = new Float32Array(3 * IMG_SIZE * IMG_SIZE);
  const mean = 0.5;
  const std = 0.5;

  for (let index = 0; index < IMG_SIZE * IMG_SIZE; index += 1) {
    tensor[index] = (data[index * 4] / 255 - mean) / std;
    tensor[index + IMG_SIZE * IMG_SIZE] =
      (data[index * 4 + 1] / 255 - mean) / std;
    tensor[index + IMG_SIZE * IMG_SIZE * 2] =
      (data[index * 4 + 2] / 255 - mean) / std;
  }

  return tensor;
}

export function usePressureInference({
  enabled,
  videoRef,
  fingerTipUv,
  previewCanvasRef,
  modelPath = DEFAULT_MODEL_PATH,
  inferHz = DEFAULT_INFER_HZ,
}: UsePressureInferenceOptions): UsePressureInferenceResult {
  const sessionRef = useRef<OrtSession | null>(null);
  const patchCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const resizeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const latestTipRef = useRef<FingertipUv | null>(fingerTipUv);

  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">(
    "idle"
  );
  const [error, setError] = useState<string | null>(null);
  const [prediction, setPrediction] = useState<PressurePredictionClass | null>(
    null
  );
  const [confidences, setConfidences] = useState<
    Record<PressurePredictionClass, number>
  >({
    Firm: 0,
    Light: 0,
    NoPress: 0,
  });
  const [inferMs, setInferMs] = useState<number | null>(null);

  useEffect(() => {
    latestTipRef.current = fingerTipUv;
    if (!fingerTipUv) {
      setPrediction(null);
      setInferMs(null);
      setConfidences({
        Firm: 0,
        Light: 0,
        NoPress: 0,
      });

      const previewCanvas = previewCanvasRef?.current;
      const previewCtx = previewCanvas?.getContext("2d");
      if (previewCanvas && previewCtx) {
        previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
      }
    }
  }, [fingerTipUv, previewCanvasRef]);

  const runInference = useCallback(async () => {
    const tip = latestTipRef.current;
    const video = videoRef.current;
    const session = sessionRef.current;
    if (!enabled || !tip || !video || !session || video.videoWidth <= 0) {
      return;
    }

    if (!patchCanvasRef.current) {
      patchCanvasRef.current = document.createElement("canvas");
    }
    if (!resizeCanvasRef.current) {
      resizeCanvasRef.current = document.createElement("canvas");
    }

    const patchCanvas = patchCanvasRef.current;
    const resizeCanvas = resizeCanvasRef.current;
    const patchCtx = patchCanvas.getContext("2d");
    const resizeCtx = resizeCanvas.getContext("2d");
    if (!patchCtx || !resizeCtx) {
      return;
    }

    const centerX = clamp(tip.u, 0, 1) * video.videoWidth;
    const centerY = clamp(tip.v, 0, 1) * video.videoHeight;
    const halfPatch = PATCH_SIZE_PX / 2;
    const sourceX = clamp(
      Math.round(centerX - halfPatch),
      0,
      Math.max(0, video.videoWidth - PATCH_SIZE_PX)
    );
    const sourceY = clamp(
      Math.round(centerY - halfPatch),
      0,
      Math.max(0, video.videoHeight - PATCH_SIZE_PX)
    );

    patchCanvas.width = PATCH_SIZE_PX;
    patchCanvas.height = PATCH_SIZE_PX;
    patchCtx.drawImage(
      video,
      sourceX,
      sourceY,
      PATCH_SIZE_PX,
      PATCH_SIZE_PX,
      0,
      0,
      PATCH_SIZE_PX,
      PATCH_SIZE_PX
    );

    resizeCanvas.width = IMG_SIZE;
    resizeCanvas.height = IMG_SIZE;
    resizeCtx.drawImage(patchCanvas, 0, 0, IMG_SIZE, IMG_SIZE);

    const previewCanvas = previewCanvasRef?.current;
    const previewCtx = previewCanvas?.getContext("2d");
    if (previewCanvas && previewCtx) {
      if (previewCanvas.width !== IMG_SIZE) previewCanvas.width = IMG_SIZE;
      if (previewCanvas.height !== IMG_SIZE) previewCanvas.height = IMG_SIZE;
      previewCtx.clearRect(0, 0, IMG_SIZE, IMG_SIZE);
      previewCtx.drawImage(resizeCanvas, 0, 0, IMG_SIZE, IMG_SIZE);
    }

    const tensorData = imageDataToTensor(resizeCanvas);
    const ort = (window as unknown as { ort?: OrtStatic }).ort;
    if (!ort) {
      return;
    }

    const inputName = session.inputNames?.[0] ?? "input";
    const outputName = session.outputNames?.[0];
    const startedAt = performance.now();

    try {
      const inputTensor = new ort.Tensor("float32", tensorData, [
        1,
        3,
        IMG_SIZE,
        IMG_SIZE,
      ]);
      const outputs = await session.run({ [inputName]: inputTensor });
      const outputTensor =
        (outputName ? outputs[outputName] : undefined) ??
        Object.values(outputs)[0];

      if (!outputTensor) {
        throw new Error("Model returned no outputs.");
      }

      const probabilities = softmax(outputTensor.data);
      const bestIndex = probabilities.indexOf(Math.max(...probabilities));

      setInferMs(Math.round(performance.now() - startedAt));
      setPrediction(CLASS_NAMES[bestIndex] ?? null);
      setConfidences({
        Firm: probabilities[0] ?? 0,
        Light: probabilities[1] ?? 0,
        NoPress: probabilities[2] ?? 0,
      });
    } catch (inferenceError) {
      console.error("[PressureInference] inference failed:", inferenceError);
    }
  }, [enabled, previewCanvasRef, videoRef]);

  useEffect(() => {
    if (!enabled) {
      setStatus(sessionRef.current ? "ready" : "idle");
      setError(null);
      return;
    }

    let cancelled = false;

    const boot = async () => {
      if (sessionRef.current) {
        setStatus("ready");
        return;
      }

      setStatus("loading");
      setError(null);

      try {
        await loadOrtRuntime();

        const ort = (window as unknown as { ort?: OrtStatic }).ort;
        if (!ort) {
          throw new Error("onnxruntime-web failed to load.");
        }

        ort.env.wasm.wasmPaths = ORT_WASM_PATH;
        const session = await ort.InferenceSession.create(modelPath);
        if (cancelled) {
          return;
        }

        sessionRef.current = session;
        setStatus("ready");
      } catch (loadError) {
        if (cancelled) {
          return;
        }

        const message =
          loadError instanceof Error ? loadError.message : String(loadError);
        setError(message);
        setStatus("error");
      }
    };

    void boot();

    return () => {
      cancelled = true;
    };
  }, [enabled, modelPath]);

  useEffect(() => {
    if (!enabled || status !== "ready") {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    let cancelled = false;
    const intervalMs = Math.max(1, Math.round(1000 / inferHz));

    const loop = () => {
      if (cancelled) {
        return;
      }

      if (latestTipRef.current) {
        void runInference();
      }

      timerRef.current = window.setTimeout(loop, intervalMs);
    };

    timerRef.current = window.setTimeout(loop, intervalMs);

    return () => {
      cancelled = true;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [enabled, inferHz, runInference, status]);

  return {
    status,
    error,
    prediction,
    confidences,
    inferMs,
  };
}
