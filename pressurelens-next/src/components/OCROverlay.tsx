"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUserCamera } from "./useUserCamera";
import { recognizeWordsFromCanvas, WordBBox } from "../lib/ocr/tesseract";
import { Point, computeHomography, isCVReady, transformRect } from "../lib/vision/homography";

type CalibMode = null | "ref" | "curr";

export default function OCROverlay() {
  const { videoRef, isReady, error } = useUserCamera();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [words, setWords] = useState<WordBBox[]>([]);
  const [mode, setMode] = useState<CalibMode>(null);
  const [refPts, setRefPts] = useState<Point[]>([]);
  const [curPts, setCurPts] = useState<Point[]>([]);
  const [H, setH] = useState<{ M: any; Minv: any } | null>(null);
  const [cvReady, setCvReady] = useState<boolean>(false);

  // 动态加载 OpenCV.js
  useEffect(() => {
    if (isCVReady()) { setCvReady(true); return; }
    const script = document.createElement("script");
    script.src = "https://docs.opencv.org/4.9.0/opencv.js";
    script.async = true;
    (window as any).Module = (window as any).Module || {};
    script.onload = () => {
      const cv = (window as any).cv;
      if (cv && cv.Mat) {
        setCvReady(true);
      } else {
        cv && (cv["onRuntimeInitialized"] = () => setCvReady(true));
      }
    };
    document.body.appendChild(script);
    return () => { script.remove(); };
  }, []);

  const runOCR = useCallback(async () => {
    const v = videoRef.current;
    if (!v) return;
    const off = document.createElement("canvas");
    off.width = v.videoWidth;
    off.height = v.videoHeight;
    const ctx = off.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(v, 0, 0, off.width, off.height);
    let canvasForOCR: HTMLCanvasElement = off;
    if (cvReady && H?.M) {
      const cv = (window as any).cv;
      const srcMat = cv.imread(off);
      const dstMat = new cv.Mat();
      const dsize = new cv.Size(off.width, off.height);
      try {
        cv.warpPerspective(srcMat, dstMat, H.M, dsize, cv.INTER_LINEAR, cv.BORDER_REPLICATE);
        const dst = document.createElement("canvas");
        dst.width = off.width;
        dst.height = off.height;
        cv.imshow(dst, dstMat);
        canvasForOCR = dst;
      } finally {
        srcMat.delete();
        dstMat.delete();
      }
    }
    const ws = await recognizeWordsFromCanvas(canvasForOCR, "eng");
    setWords(ws);
  }, [videoRef]);

  const resetCalib = useCallback(() => {
    setRefPts([]);
    setCurPts([]);
    if (H) {
      try { H.M?.delete?.(); } catch {}
      try { H.Minv?.delete?.(); } catch {}
    }
    setH(null);
  }, [H]);

  const onCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!mode) return;
    const c = canvasRef.current!;
    const v = videoRef.current!;
    const rect = c.getBoundingClientRect();
    // 画布是镜像显示（scaleX(-1)），坐标需反镜像回原始像素系
    const xDisplay = e.clientX - rect.left;
    const yDisplay = e.clientY - rect.top;
    const xMirrored = c.width - xDisplay;
    const scaleX = v.videoWidth ? c.width / v.videoWidth : 1;
    const scaleY = v.videoHeight ? c.height / v.videoHeight : 1;
    const xVideo = xMirrored / scaleX;
    const yVideo = yDisplay / scaleY;

    if (mode === "ref") {
      setRefPts((arr) => (arr.length >= 4 ? arr : [...arr, { x: xVideo, y: yVideo }]));
    } else if (mode === "curr") {
      setCurPts((arr) => (arr.length >= 4 ? arr : [...arr, { x: xVideo, y: yVideo }]));
    }
  }, [mode, videoRef]);

  useEffect(() => {
    if (!cvReady) return;
    if (refPts.length === 4 && curPts.length === 4) {
      if (H) {
        try { H.M?.delete?.(); } catch {}
        try { H.Minv?.delete?.(); } catch {}
      }
      const h = computeHomography(curPts, refPts); // curr -> ref
      setH(h);
      setMode(null);
    }
  }, [refPts, curPts, cvReady]);

  // 绘制 overlay（镜像显示）
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const v = videoRef.current;
      const c = canvasRef.current;
      if (!v || !c) { raf = requestAnimationFrame(draw); return; }
      // 同步尺寸
      const displayWidth = v.clientWidth;
      const displayHeight = v.clientHeight;
      if (displayWidth === 0 || displayHeight === 0) { raf = requestAnimationFrame(draw); return; }
      if (c.width !== displayWidth) c.width = displayWidth;
      if (c.height !== displayHeight) c.height = displayHeight;
      const ctx = c.getContext("2d")!;
      ctx.clearRect(0, 0, c.width, c.height);

      // 将视频原始像素 → 画布显示像素的缩放
      const scaleX = v.videoWidth ? c.width / v.videoWidth : 1;
      const scaleY = v.videoHeight ? c.height / v.videoHeight : 1;

      ctx.save();
      // 画布镜像以匹配视频的 scaleX(-1)
      ctx.scale(-1, 1);
      ctx.translate(-c.width, 0);

      // 绘制 OCR 框
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(0,0,0,0.9)";
      ctx.fillStyle = "rgba(255,255,0,0.18)";
      for (const w of words) {
        if (H?.Minv) {
          const poly = transformRect(H.Minv, w.bbox).map((p) => ({ x: p.x * scaleX, y: p.y * scaleY }));
          ctx.beginPath();
          ctx.moveTo(poly[0].x, poly[0].y);
          for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        } else {
          const x = w.bbox.x * scaleX;
          const y = w.bbox.y * scaleY;
          const W = w.bbox.w * scaleX;
          const Hh = w.bbox.h * scaleY;
          ctx.fillRect(x, y, W, Hh);
          ctx.strokeRect(x, y, W, Hh);
        }
      }

      // 绘制标定点
      const drawPts = (pts: Point[], color: string) => {
        ctx.fillStyle = color;
        for (const p of pts) {
          const x = p.x * scaleX;
          const y = p.y * scaleY;
          ctx.beginPath();
          ctx.arc(x, y, 5, 0, Math.PI * 2);
          ctx.fill();
        }
      };
      drawPts(refPts, "rgba(0,200,255,0.9)");
      drawPts(curPts, "rgba(255,0,120,0.9)");

      ctx.restore();

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [videoRef, words, refPts, curPts, H]);

  const statusText = useMemo(() => {
    if (error) return `摄像头错误: ${error}`;
    if (!isReady) return "相机初始化中...";
    if (!words.length) return "未运行 OCR";
    return `词数: ${words.length}`;
  }, [isReady, error, words]);

  return (
    <div className="w-full max-w-4xl mx-auto">
      <div className="relative">
        <video
          ref={videoRef}
          className="w-full rounded-xl shadow"
          playsInline
          muted
          style={{ transform: "scaleX(-1)" }}
        />
        <canvas
          ref={canvasRef}
          className="absolute inset-0 pointer-events-auto"
          onClick={onCanvasClick}
        />
      </div>

      <div className="mt-3 flex flex-wrap gap-8 items-center">
        <button
          className="px-4 py-2 rounded-lg bg-black text-white disabled:opacity-50"
          disabled={!isReady}
          onClick={runOCR}
        >
          识别当前帧（OCR / eng）
        </button>

        <button
          className="px-4 py-2 rounded-lg bg-slate-800 text-white disabled:opacity-50"
          disabled={!isReady}
          onClick={() => { setMode("ref"); setRefPts([]); }}
        >
          选择参考四角
        </button>

        <button
          className="px-4 py-2 rounded-lg bg-slate-700 text-white disabled:opacity-50"
          disabled={!isReady || refPts.length !== 4}
          onClick={() => { setMode("curr"); setCurPts([]); }}
        >
          选择当前四角
        </button>

        <button
          className="px-4 py-2 rounded-lg bg-gray-200"
          onClick={resetCalib}
        >
          清除标定
        </button>

        <span className="text-sm opacity-70">{statusText} {cvReady ? "| OpenCV: OK" : "| OpenCV: 加载中..."}</span>
      </div>
    </div>
  );
}


