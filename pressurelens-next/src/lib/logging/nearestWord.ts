import type { WordBBox } from "../ocr/tesseract";
import type { NearestWordInfo } from "./types";

type OcrRegion = { left: number; top: number; width: number; height: number };

/**
 * 将 OCR 词框坐标从高分辨率裁剪坐标系映射到屏幕像素坐标系，
 * 使用与 page.tsx 中绘制 overlay 相同的逻辑。
 */
function projectWordToScreen(
  word: WordBBox,
  region: OcrRegion,
  ocrScale: number,
  dpr: number
): { x: number; y: number } {
  const scaleBack = (val: number) => val / (dpr * (ocrScale || 1));
  const x = region.left + scaleBack(word.bbox.x + word.bbox.w / 2);
  const y = region.top + scaleBack(word.bbox.y + word.bbox.h / 2);
  return { x, y };
}

export function getNearestOcrWord(
  words: WordBBox[] | null,
  region: OcrRegion | null,
  ocrScale: number | null,
  pointer: { x: number; y: number } | null,
  opts?: { dpr?: number; maxDistancePx?: number }
): NearestWordInfo | null {
  if (!words || !words.length || !region || !ocrScale || !pointer) return null;
  const dpr = opts?.dpr ?? (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
  const maxDist = opts?.maxDistancePx ?? Infinity;

  // 1) 先按“指读场景”做一轮：优先选“手指上方一列”的词
  // 约束：
  // - y 方向：词的中心尽量在手指下方（y >= pointer.y），允许最多 10px 的误差
  // - x 方向：词的中心与手指的水平距离不超过 80px（可按需要调）
  // 在满足约束的候选里，优先：
  // - 先看 y 距离（越近越好）
  // - 再看 x 距离（越近越好）
  let bestAligned: NearestWordInfo | null = null;
  let bestAlignedDy = Infinity;
  let bestAlignedDx = Infinity;

  // 2) 兜底：如果找不到“正下方”的词，再退回到简单的欧氏距离最近
  let bestFallback: NearestWordInfo | null = null;
  let bestFallbackDist = maxDist;

  for (const w of words) {
    const center = projectWordToScreen(w, region, ocrScale, dpr);
    const dx = center.x - pointer.x;
    const dy = center.y - pointer.y;
    const dist = Math.hypot(dx, dy);

    // 2.1 记录兜底最近点（任意方向）
    if (dist < bestFallbackDist) {
      bestFallbackDist = dist;
      bestFallback = {
        text: w.text,
        bbox: { ...w.bbox },
        distance: dist,
      };
    }

    // 2.2 指读优先逻辑：只考虑“手指垂直方向上的词”
    const dxAbs = Math.abs(dx);
    const dyFromFinger = dy; // >0 表示在手指下方，<0 表示在手指上方

    const verticalTolerance = 10; // 允许略高于手指 10px
    const horizontalTolerance = 80; // 手指左右各 80px 范围

    const isVerticallyAligned = dyFromFinger >= -verticalTolerance;
    const isHorizontallyClose = dxAbs <= horizontalTolerance;

    if (isVerticallyAligned && isHorizontallyClose) {
      // 目标：优先“刚好在手指下方且对齐”的词
      const dyScore = Math.max(dyFromFinger, 0); // 上方的词算 0，正下方越近越好

      if (
        dyScore < bestAlignedDy ||
        (dyScore === bestAlignedDy && dxAbs < bestAlignedDx)
      ) {
        bestAlignedDy = dyScore;
        bestAlignedDx = dxAbs;
        bestAligned = {
          text: w.text,
          bbox: { ...w.bbox },
          distance: dist,
        };
      }
    }
  }

  // 有符合“指读几何逻辑”的词，优先返回它；否则退回到全局最近点
  return bestAligned ?? bestFallback;
}


