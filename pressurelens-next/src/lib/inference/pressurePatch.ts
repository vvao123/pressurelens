import type { FingertipUv } from "./usePressureInference";

export type PressurePatchSourceRect = {
  sourceX: number;
  sourceY: number;
  sourceSizePx: number;
  centerX: number;
  centerY: number;
};

export const PRESSURE_FINGERTIP_V_COMPENSATION = 0.0001;

export const PRESSURE_CAMERA_CONSTRAINTS: MediaStreamConstraints["video"] = {
  facingMode: { ideal: "user" },
  width: { ideal: 1920, min: 1280 },
  height: { ideal: 1080, min: 720 },
  frameRate: { ideal: 30, min: 15 },
};

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function normalizePressureFingertipUv(
  tip: { x: number; y: number } | FingertipUv,
  vCompensation = PRESSURE_FINGERTIP_V_COMPENSATION
): FingertipUv {
  const rawU = "u" in tip ? tip.u : tip.x;
  const rawV = "v" in tip ? tip.v : tip.y;

  return {
    u: clamp(rawU, 0, 1),
    v: clamp(rawV * (1 - vCompensation), 0, 1),
  };
}

export function getPressurePatchSourceRect(
  video: Pick<HTMLVideoElement, "videoWidth" | "videoHeight">,
  fingerTipUv: FingertipUv,
  cropSizePx: number
): PressurePatchSourceRect | null {
  if (video.videoWidth <= 0 || video.videoHeight <= 0) {
    return null;
  }

  const centerX = clamp(fingerTipUv.u, 0, 1) * video.videoWidth;
  const centerY = clamp(fingerTipUv.v, 0, 1) * video.videoHeight;
  const halfPatch = cropSizePx / 2;
  const sourceX = clamp(
    Math.round(centerX - halfPatch),
    0,
    Math.max(0, video.videoWidth - cropSizePx)
  );
  const sourceY = clamp(
    Math.round(centerY - halfPatch),
    0,
    Math.max(0, video.videoHeight - cropSizePx)
  );

  return {
    sourceX,
    sourceY,
    sourceSizePx: cropSizePx,
    centerX,
    centerY,
  };
}

export function drawPressurePatchFromVideo(
  video: HTMLVideoElement,
  fingerTipUv: FingertipUv,
  outputCanvas: HTMLCanvasElement,
  cropSizePx: number
): PressurePatchSourceRect | null {
  const rect = getPressurePatchSourceRect(video, fingerTipUv, cropSizePx);
  if (!rect) return null;

  outputCanvas.width = cropSizePx;
  outputCanvas.height = cropSizePx;
  const ctx = outputCanvas.getContext("2d");
  if (!ctx) return null;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.clearRect(0, 0, cropSizePx, cropSizePx);
  ctx.drawImage(
    video,
    rect.sourceX,
    rect.sourceY,
    rect.sourceSizePx,
    rect.sourceSizePx,
    0,
    0,
    cropSizePx,
    cropSizePx
  );

  return rect;
}
