"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type UseUserCameraResult = {
  videoRef: React.RefObject<HTMLVideoElement>;
  isReady: boolean;
  error: string | null;
  stop: () => void;
};

// 复用 page.tsx 的摄像头约束：用户前摄 + 高分辨率 + 30fps + 方形优先
const DEFAULT_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    facingMode: { ideal: "user" },
    width: { ideal: 19200, min: 1280 },
    height: { ideal: 10800, min: 720 },
    frameRate: { ideal: 30, min: 15 },
    // 更好画质（参考现有实现）
    aspectRatio: { ideal: 1 },
  },
  audio: false,
};

export function useUserCamera(
  constraints: MediaStreamConstraints = DEFAULT_CONSTRAINTS
): UseUserCameraResult {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (cancelled) return;
        streamRef.current = stream;
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          v.muted = true;
          try {
            await v.play();
          } catch {}
          setIsReady(true);
        }
      } catch (e: any) {
        setError(e?.message ?? "getUserMedia failed");
      }
    })();
    return () => {
      cancelled = true;
      // 清理流
      if (streamRef.current) {
        for (const track of streamRef.current.getTracks()) {
          try {
            track.stop();
          } catch {}
        }
        streamRef.current = null;
      }
    };
  }, [constraints]);

  const stop = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        try {
          track.stop();
        } catch {}
      }
      streamRef.current = null;
    }
  }, []);

  return { videoRef, isReady, error, stop };
}


