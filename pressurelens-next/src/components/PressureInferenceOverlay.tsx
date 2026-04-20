"use client";

import { useRef } from "react";
import type { RefObject } from "react";
import {
  usePressureInference,
  type FingertipUv,
  type PressurePredictionClass,
} from "../lib/inference/usePressureInference";

type ScreenPoint = {
  x: number;
  y: number;
};

type PressureInferenceOverlayProps = {
  enabled: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  fingerTipPosition: ScreenPoint | null;
  fingerTipUv: FingertipUv | null;
};

const MODEL_NAME = "pressure_cnn_v1.onnx";

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
}: PressureInferenceOverlayProps) {
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const { status, error, prediction, confidences, inferMs } =
    usePressureInference({
      enabled,
      videoRef,
      fingerTipUv,
      previewCanvasRef,
    });

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
          width={64}
          height={64}
          className="block border border-yellow-300/70"
          style={{
            width: "96px",
            height: "96px",
            imageRendering: "pixelated",
          }}
        />
        <div className="mt-1 text-[10px] text-white/55">64x64 RGB</div>
      </div>

      <div className="absolute right-3 top-3 z-30 w-44 overflow-hidden rounded-xl border border-white/10 bg-black/65 text-white shadow-xl backdrop-blur-sm pointer-events-none">
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

          <div className="flex items-center justify-between text-[10px] text-white/55">
            <span>Model</span>
            <span className="font-mono">{MODEL_NAME}</span>
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
