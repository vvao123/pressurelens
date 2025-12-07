// import type { WordBBox } from "../ocr/tesseract";
// import type { NearestWordInfo } from "./types";

// type OcrRegion = { left: number; top: number; width: number; height: number };

// /**
//  * 将 OCR 词框坐标从高分辨率裁剪坐标系映射到屏幕像素坐标系，
//  * 使用与 page.tsx 中绘制 overlay 相同的逻辑。
//  */
// function projectWordToScreen(
//   word: WordBBox,
//   region: OcrRegion,
//   ocrScale: number,
//   dpr: number
// ): { x: number; y: number } {
//   const scaleBack = (val: number) => val / (dpr * (ocrScale || 1));
//   const x = region.left + scaleBack(word.bbox.x + word.bbox.w / 2);
//   const y = region.top + scaleBack(word.bbox.y + word.bbox.h / 2);
//   return { x, y };
// }

// export function getNearestOcrWord(
//   words: WordBBox[] | null,
//   region: OcrRegion | null,
//   ocrScale: number | null,
//   pointer: { x: number; y: number } | null,
//   opts?: { dpr?: number; maxDistancePx?: number }
// ): NearestWordInfo | null {
//   if (!words || !words.length || !region || !ocrScale || !pointer) return null;
//   const dpr = opts?.dpr ?? (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);

//   // 几何直觉（以屏幕像素为单位）：
//   // - 一行文字的行高大约 20~40px（视字体而定）；
//   // - 对“正上方”的理解：在手指上方一小段垂直带内，横向偏移很小；
//   // - 只有当这条“竖直带”里找不到合适的 box，或者 box 离手指太远，
//   //   才退而在更宽的行带里找左右相邻的词。
//   //
//   // 因此这里分两层：
//   // 1) column 候选：严格“正上方一列”的词
//   // 2) row  候选：同一行附近、左右扩展一些的词

//   // 垂直窗口：只看手指上方 30px 以内
//   const LINE_UP_MAX = 30;
//   // 正上方“竖直带”的最大水平偏移（列宽）
//   const COLUMN_X_TOL = 25;
//   // 行内允许的最大水平偏移（左右各）
//   const ROW_X_TOL = 80;
//   // 如果正上方词离手指太远（> 20px），就认为“不够准”，允许考虑旁边行内词
//   const MAX_COLUMN_DIST_Y = 20;

//   let bestColumn: NearestWordInfo | null = null;
//   let bestColumnDy = Infinity;
//   let bestColumnDx = Infinity;

//   let bestRow: NearestWordInfo | null = null;
//   let bestRowDy = Infinity;
//   let bestRowDx = Infinity;

//   for (const w of words) {
//     const center = projectWordToScreen(w, region, ocrScale, dpr);
//     const dx = center.x - pointer.x;
//     const dy = center.y - pointer.y; // dy < 0: 在手指上方；dy > 0: 在手指下方

//     const absDx = Math.abs(dx);
//     const absDy = Math.abs(dy);

//     // 1) 先收集“正上方一列”的候选：在 finger 正上方的小竖条里
//     //    条件：在手指上方（不允许低于手指），且高度不超过一行（LINE_UP_MAX）
//     if (dy <= -2 && dy >= -LINE_UP_MAX && absDx <= COLUMN_X_TOL) {
//       if (
//         absDy < bestColumnDy - 1 || // Y 明显更近
//         (Math.abs(absDy - bestColumnDy) <= 1 && absDx < bestColumnDx) // Y 差不多时，选 X 更近的
//       ) {
//         bestColumnDy = absDy;
//         bestColumnDx = absDx;
//         bestColumn = {
//           text: w.text,
//           bbox: { ...w.bbox },
//           distance: Math.hypot(dx, dy),
//         };
//       }
//     }

//     // 2) 再收集“同一行附近”的候选：允许稍微偏左/偏右，或略高/略低一些
//     //    条件：仍然限制在手指上方一行内（-LINE_UP_MAX ~ 0），不考虑明显在下方的词；
//     //    横向窗口更宽，用于在“正上方没有理想候选”时，选择邻近的词。
//     if (dy <= 0 && dy >= -LINE_UP_MAX && absDx <= ROW_X_TOL) {
//       if (
//         absDy < bestRowDy - 1 ||
//         (Math.abs(absDy - bestRowDy) <= 1 && absDx < bestRowDx)
//       ) {
//         bestRowDy = absDy;
//         bestRowDx = absDx;
//         bestRow = {
//           text: w.text,
//           bbox: { ...w.bbox },
//           distance: Math.hypot(dx, dy),
//         };
//       }
//     }
//   }

//   // 先尝试返回“正上方一列”的词，只要不离得太远
//   if (bestColumn && bestColumnDy <= MAX_COLUMN_DIST_Y) {
//     return bestColumn;
//   }

//   // 否则，如果同一行附近有词，再退到行内最近的
//   if (bestRow) {
//     return bestRow;
//   }

//   // 再否则，就认为此处没有合适的词
//   return null;
// }
import type { WordBBox } from "../ocr/tesseract";
import type { NearestWordInfo } from "./types";

type OcrRegion = { left: number; top: number; width: number; height: number };

// 辅助：计算屏幕坐标
function projectWordToScreen(
  word: WordBBox,
  region: OcrRegion,
  ocrScale: number,
  dpr: number
): { bbox: { x: number; y: number; w: number; h: number }; centerY: number; centerX: number } {
  const scaleBack = (val: number) => val / (dpr * (ocrScale || 1));
  
  const x = region.left + scaleBack(word.bbox.x);
  const y = region.top + scaleBack(word.bbox.y);
  const w = scaleBack(word.bbox.w);
  const h = scaleBack(word.bbox.h);

  return {
    bbox: { x, y, w, h },
    centerX: x + w / 2,
    centerY: y + h / 2
  };
}

// 核心辅助函数：判断两个垂直区间是否显著重叠
// 判断 word 是否属于 line (根据 line 的当前边界)
function isSameLine(
  lineBox: { top: number; bottom: number }, 
  wordBox: { top: number; bottom: number }
): boolean {
  // 1. 计算重叠部分的高度
  const intersectionTop = Math.max(lineBox.top, wordBox.top);
  const intersectionBottom = Math.min(lineBox.bottom, wordBox.bottom);
  const overlapHeight = Math.max(0, intersectionBottom - intersectionTop);

  // 2. 计算当前词的高度
  const wordHeight = wordBox.bottom - wordBox.top;

  // 3. 判定标准：如果重叠高度超过词本身高度的 50%，或者超过行高度的 50%
  // 这种相对比例判定，对大字小字都适用。
  if (wordHeight === 0) return false;
  return (overlapHeight / wordHeight) > 0.5;
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

  // ============================================
  // Step 1: 粗略筛选候选集 (ROI)
  // ============================================
  const ROI_X = 50; 
  const ROI_Y_TOP = 20; 
  const ROI_Y_BOTTOM = 10; // 稍微放宽一点

  const candidates = [];

  for (const w of words) {
    const screenWord = projectWordToScreen(w, region, ocrScale, dpr);
    
    // 边缘距离计算
    const left = screenWord.bbox.x;
    const right = screenWord.bbox.x + screenWord.bbox.w;
    let dx = 0;
    if (pointer.x < left) dx = left - pointer.x;
    else if (pointer.x > right) dx = pointer.x - right;

    const wordBottom = screenWord.bbox.y + screenWord.bbox.h;
    const distFromFingerToBottom = pointer.y - wordBottom;

    if (dx < ROI_X && 
        distFromFingerToBottom > -ROI_Y_BOTTOM && 
        distFromFingerToBottom < ROI_Y_TOP
       ) {
      candidates.push({ ...screenWord, original: w });
    }
  }

  if (candidates.length === 0) return null;

  // ============================================
  // Step 2: 自适应行聚类 (Vertical Overlap)
  // ============================================
  
  // 1. 先按 Top 排序，保证我们是从上往下处理
  candidates.sort((a, b) => a.bbox.y - b.bbox.y);

  type LineGroup = {
    words: typeof candidates;
    // 记录这一行的“并集”边界，用于判断后续单词是否属于该行
    unionTop: number;   
    unionBottom: number;
    // 记录统计值用于最终决策
    avgBottom: number; 
  };

  const lines: LineGroup[] = [];

  for (const word of candidates) {
    const wTop = word.bbox.y;
    const wBottom = word.bbox.y + word.bbox.h;
    
    let added = false;
    
    // 尝试把词加入已有的行 (通常只需要检查最后一行，因为是排好序的，但也可能出现重叠布局)
    // 这里为了保险，我们可以遍历所有已生成的行（通常就1-3行）
    for (const line of lines) {
      if (isSameLine({ top: line.unionTop, bottom: line.unionBottom }, { top: wTop, bottom: wBottom })) {
        line.words.push(word);
        
        // 动态更新该行的垂直边界范围 (取并集)
        // 这样如果一行里有个很高的字，它会撑大这一行的捕获范围
        line.unionTop = Math.min(line.unionTop, wTop);
        line.unionBottom = Math.max(line.unionBottom, wBottom);
        
        // 更新 avgBottom
        const n = line.words.length;
        line.avgBottom = (line.avgBottom * (n - 1) + wBottom) / n;
        
        added = true;
        break;
      }
    }

    // 如果不属于任何现有行，创建新行
    if (!added) {
      lines.push({
        words: [word],
        unionTop: wTop,
        unionBottom: wBottom,
        avgBottom: wBottom
      });
    }
  }
  // 【新增修复】：对每一行内部的词，按 X 轴 (Left) 重新排序
  // 这样 console.log 打印出来的句子才是通顺的，逻辑也更符合直觉
  lines.forEach(line => {
    line.words.sort((a, b) => a.bbox.x - b.bbox.x);
  });
    // 【调试点 3】: 观察聚类结果 (非常关键！)
  // 观察：本来是一行字，被分成了几行？
  // 如果明明是一行却显示 length: 2，说明 isSameLine 判断太严格。
  console.log('[OCR] Step 2 Clusters:', lines.map(l => ({
    textPreview: l.words.map(w => w.original.text).join(' '), 
    avgBottom: Math.round(l.avgBottom),
    wordCount: l.words.length
  })));


  // ============================================
  // Step 3: 选择“最佳行”
  // ============================================
  // 逻辑：找到 Bottom 在手指上方（或附近）的那一行
  
  let bestLine: LineGroup | null = null;
  let minLineDist = Infinity;

  for (const line of lines) {
    // 指读判定：手指应当位于文字底部的下方
    // diff > 0: 手指在文字下方 (正常)
    // diff < 0: 手指在文字上方 (遮挡)
    const distToLineBottom = pointer.y - line.avgBottom;
    // 【调试点 4】: 观察行选择逻辑
    // 观察：为什么选中了这一行？distToLineBottom 是正数还是负数？
    // console.log(`[OCR] Checking Line: "${line.words[0].original.text}...", distToBottom: ${distToLineBottom.toFixed(1)}`);


    // 宽松判定：允许手指稍微盖住文字底部 15px (distToLineBottom > -15)
    // 但不能太远，比如手指在文字下方 50px 处，那可能已经指到下一行空白了，不应该算这一行
    if (distToLineBottom > -15 && distToLineBottom < 60) {
      const absDist = Math.abs(distToLineBottom);
      if (absDist < minLineDist) {
        minLineDist = absDist;
        bestLine = line;
      }
    }
  }

  if (!bestLine) return null;

  // ============================================
  // Step 4: 边缘距离选词 (同前)
  // ============================================
  let bestWord: NearestWordInfo | null = null;
  let minDx = Infinity;

  // 为 NearestWordInfo 准备行上下文：
  // - linesText: 所有行的 w.original.text 列表（按从上到下、从左到右）
  // - bestLineIndex: 指明哪一行是当前选中的“最佳行”
  const allLinesText = lines.map((l) => l.words.map((w) => w.original.text));
  const bestLineIndex = Math.max(0, lines.indexOf(bestLine));
  const lineContext = {
    linesText: allLinesText,
    bestLineIndex,
  };

  for (const word of bestLine.words) {
    const box = word.bbox;
    const left = box.x;
    const right = box.x + box.w;

    let dx = 0;
    if (pointer.x < left) dx = left - pointer.x;
    else if (pointer.x > right) dx = pointer.x - right;
    else dx = 0;

    if (dx < minDx) {
      minDx = dx;
      const realDist = Math.hypot(
        word.centerX - pointer.x,
        word.centerY - pointer.y
      );
      bestWord = {
        text: word.original.text,
        bbox: word.original.bbox,
        distance: realDist,
        lineContext,
      };
    }
  }

  return bestWord;
}

