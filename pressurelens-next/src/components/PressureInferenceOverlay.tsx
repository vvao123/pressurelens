"use client";

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  usePressureInference,
  type FingertipUv,
  type PressurePredictionClass,
} from "../lib/inference/usePressureInference";
import {
  DEFAULT_PRESSURE_INFERENCE_MODEL_CONFIG,
  type PressureInferenceModelConfig,
} from "../lib/inference/pressureInferenceConfig";
import {
  PRESSURE_MODEL_UPDATED_EVENT,
  PRESSURE_MODEL_USER_STORAGE_KEY,
  buildPressureModelUrl,
} from "../lib/inference/pressureModelRegistration";

type ScreenPoint = {
  x: number;
  y: number;
};

type PressureInferenceOverlayProps = {
  enabled: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  fingerTipPosition: ScreenPoint | null;
  fingerTipUv: FingertipUv | null;
  onPrediction?: (snapshot: {
    prediction: PressurePredictionClass | null;
    confidences: Record<PressurePredictionClass, number>;
    inferMs: number | null;
    status: "idle" | "loading" | "ready" | "error";
  }) => void;
};

const CLASS_COLORS: Record<
  PressurePredictionClass,
  { badge: string; bar: string; shadow: string }
> = {
  Firm: {
    badge: "border-red-300/70 bg-red-500/90 text-white",
    bar: "bg-red-400",
    shadow: "shadow-red-500/50",
  },
  Light: {
    badge: "border-amber-200/80 bg-amber-400/90 text-black",
    bar: "bg-amber-300",
    shadow: "shadow-amber-400/50",
  },
  NoPress: {
    badge: "border-emerald-300/70 bg-emerald-500/90 text-white",
    bar: "bg-emerald-400",
    shadow: "shadow-emerald-500/50",
  },
};

export default function PressureInferenceOverlay({
  enabled,
  videoRef,
  fingerTipPosition,
  fingerTipUv,
  onPrediction,
}: PressureInferenceOverlayProps) {
  const [modelConfig, setModelConfig] = useState<PressureInferenceModelConfig>(
    DEFAULT_PRESSURE_INFERENCE_MODEL_CONFIG
  );
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const loadRegisteredModelConfig = () => {
      const userId = window.localStorage
        .getItem(PRESSURE_MODEL_USER_STORAGE_KEY)
        ?.trim();

      if (!userId) {
        setModelConfig(DEFAULT_PRESSURE_INFERENCE_MODEL_CONFIG);
        return;
      }

      setModelConfig({
        ...DEFAULT_PRESSURE_INFERENCE_MODEL_CONFIG,
        modelPath: buildPressureModelUrl(userId, Date.now()),
        modelName: `registered:${userId}`,
      });
    };

    loadRegisteredModelConfig();
    window.addEventListener("storage", loadRegisteredModelConfig);
    window.addEventListener(PRESSURE_MODEL_UPDATED_EVENT, loadRegisteredModelConfig);

    return () => {
      window.removeEventListener("storage", loadRegisteredModelConfig);
      window.removeEventListener(
        PRESSURE_MODEL_UPDATED_EVENT,
        loadRegisteredModelConfig
      );
    };
  }, []);

  const { status, error, prediction, confidences, inferMs } =
    usePressureInference({
      enabled,
      videoRef,
      fingerTipUv,
      previewCanvasRef,
      modelConfig,
    });

  useEffect(() => {
    onPrediction?.({ prediction, confidences, inferMs, status });
  }, [confidences, inferMs, onPrediction, prediction, status]);

  if (!enabled) {
    return null;
  }

  const activeColors = prediction ? CLASS_COLORS[prediction] : null;
  const statusTone =
    status === "ready"
      ? "text-emerald-300"
      : status === "loading"
        ? "text-amber-200"
        : status === "error"
          ? "text-red-300"
          : "text-white/55";

  return (
    <>
      {fingerTipPosition && prediction && activeColors && (
        <div
          className={`absolute z-30 -translate-x-1/2 rounded-full border px-3 py-1 text-[11px] font-semibold shadow-lg pointer-events-none ${activeColors.badge} ${activeColors.shadow}`}
          style={{
            left: `${fingerTipPosition.x}px`,
            top: `${fingerTipPosition.y + 20}px`,
          }}
        >
          {prediction}
        </div>
      )}

      <div className="absolute bottom-3 left-3 z-30 overflow-hidden rounded-lg border border-yellow-300/70 bg-black/70 p-2 shadow-xl backdrop-blur-sm pointer-events-none">
        <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-yellow-100/80">
          Model Input
        </div>
        <canvas
          ref={previewCanvasRef}
          width={modelConfig.inputSizePx}
          height={modelConfig.inputSizePx}
          className="block border border-yellow-300/70"
          style={{
            width: "96px",
            height: "96px",
            imageRendering: "pixelated",
          }}
        />
        <div className="mt-1 text-[10px] text-white/55">
          {modelConfig.inputSizePx}x{modelConfig.inputSizePx} RGB
        </div>
      </div>

      <div className="absolute right-3 top-3 z-30 w-56 overflow-hidden rounded-xl border border-white/10 bg-black/65 text-white shadow-xl backdrop-blur-sm pointer-events-none">
        <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
          <div className="text-[10px] uppercase tracking-[0.18em] text-white/50">
            Pressure
          </div>
          <div className={`text-[11px] font-medium ${statusTone}`}>
            {status === "ready"
              ? "Ready"
              : status === "loading"
                ? "Loading"
                : status === "error"
                  ? "Error"
                  : "Idle"}
          </div>
        </div>

        <div className="space-y-2 px-3 py-3">
          <div
            className={`rounded-lg border px-2 py-1.5 text-center text-sm font-semibold ${
              activeColors
                ? activeColors.badge
                : "border-white/10 bg-white/10 text-white/60"
            }`}
          >
            {prediction ?? (fingerTipUv ? "Analyzing" : "No Hand")}
          </div>

          {(["Firm", "Light", "NoPress"] as PressurePredictionClass[]).map(
            (label) => {
              const value = Math.round((confidences[label] ?? 0) * 100);
              return (
                <div key={label} className="space-y-1">
                  <div className="flex items-center justify-between text-[10px] text-white/70">
                    <span>{label}</span>
                    <span>{value}%</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                    <div
                      className={`h-full rounded-full ${CLASS_COLORS[label].bar}`}
                      style={{ width: `${value}%` }}
                    />
                  </div>
                </div>
              );
            }
          )}

          <div className="space-y-1 text-[10px] text-white/55">
            <div>Model</div>
            <div className="break-all font-mono text-white/70">
              {modelConfig.modelName}
            </div>
          </div>

          <div className="flex items-center justify-between text-[10px] text-white/55">
            <span>Patch</span>
            <span className="font-mono">
              {modelConfig.cropSizePx}px to {modelConfig.inputSizePx}px
            </span>
          </div>

          <div className="flex items-center justify-between text-[10px] text-white/55">
            <span>Latency</span>
            <span className="font-mono">
              {inferMs !== null ? `${inferMs}ms` : "--"}
            </span>
          </div>

          {error && (
            <div className="rounded-md border border-red-400/30 bg-red-500/10 px-2 py-1 text-[10px] text-red-200">
              {error}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
