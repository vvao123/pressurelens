// import type { WordBBox } from "../ocr/tesseract";
// import type { NearestWordInfo } from "./types";

// type OcrRegion = { left: number; top: number; width: number; height: number };

// /**
//  * Map OCR word boxes from high-res crop coordinates to screen pixels,
//  * using the same logic as the overlay drawing in page.tsx.
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

//   // Geometry intuition (screen pixels):
//   // - Line height is roughly 20~40px (depends on font);
//   // - "Directly above" means a narrow vertical band above the finger;
//   // - Only if no suitable box is found in that band or it's too far,
//   //   fall back to a wider row band to find nearby words.
//   //
//   // Two layers here:
//   // 1) column candidates: strictly the "above column"
//   // 2) row candidates: nearby words in the same row, with wider tolerance

//   // Vertical window: only within 30px above the finger
//   const LINE_UP_MAX = 30;
//   // Max horizontal offset for the above "column" band
//   const COLUMN_X_TOL = 25;
//   // Max horizontal offset within the row (left/right)
//   const ROW_X_TOL = 80;
//   // If the above word is too far (> 20px), consider nearby row words
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
//     const dy = center.y - pointer.y; // dy < 0: above finger; dy > 0: below finger

//     const absDx = Math.abs(dx);
//     const absDy = Math.abs(dy);

//     // 1) Collect strict "above column" candidates in a narrow band
//     //    Conditions: above the finger (not below), within LINE_UP_MAX
//     if (dy <= -2 && dy >= -LINE_UP_MAX && absDx <= COLUMN_X_TOL) {
//       if (
//         absDy < bestColumnDy - 1 || // Y clearly closer
//         (Math.abs(absDy - bestColumnDy) <= 1 && absDx < bestColumnDx) // If Y similar, pick closer X
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

//     // 2) Collect "nearby row" candidates: allow some left/right offset
//     //    Still within one line above (-LINE_UP_MAX ~ 0), not below;
//     //    Wider horizontal window for fallback when no strict candidate.
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

//   // Prefer the strict above-column word if not too far
//   if (bestColumn && bestColumnDy <= MAX_COLUMN_DIST_Y) {
//     return bestColumn;
//   }

//   // Otherwise, fall back to the nearest word in the row
//   if (bestRow) {
//     return bestRow;
//   }

//   // Otherwise, no suitable word
//   return null;
// }
import type { WordBBox } from "../ocr/tesseract";
import type { NearestWordInfo } from "./types";

type OcrRegion = { left: number; top: number; width: number; height: number };

// Helper: compute screen coordinates
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

// Core helper: check whether two vertical ranges significantly overlap
// Check whether a word belongs to a line (based on current line bounds)
function isSameLine(
  lineBox: { top: number; bottom: number }, 
  wordBox: { top: number; bottom: number }
): boolean {
  // 1) Compute overlap height
  const intersectionTop = Math.max(lineBox.top, wordBox.top);
  const intersectionBottom = Math.min(lineBox.bottom, wordBox.bottom);
  const overlapHeight = Math.max(0, intersectionBottom - intersectionTop);

  // 2) Compute word height
  const wordHeight = wordBox.bottom - wordBox.top;

  // 3) Criterion: overlap > 50% of word height or line height
  // Relative thresholds work for both large and small text.
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
  // Step 1: coarse candidate filtering (ROI)
  // ============================================
  const ROI_X = 50; 
  const ROI_Y_TOP = 20; 
  const ROI_Y_BOTTOM = 10; // Slightly relaxed

  const candidates = [];

  for (const w of words) {
    const screenWord = projectWordToScreen(w, region, ocrScale, dpr);
    
    // Edge distance calculation
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
  // Step 2: adaptive line clustering (vertical overlap)
  // ============================================
  
  // 1) Sort by top so we process top-down
  candidates.sort((a, b) => a.bbox.y - b.bbox.y);

  type LineGroup = {
    words: typeof candidates;
    // Track union bounds for this line to decide membership
    unionTop: number;   
    unionBottom: number;
    // Stats for final decision
    avgBottom: number; 
  };

  const lines: LineGroup[] = [];

  for (const word of candidates) {
    const wTop = word.bbox.y;
    const wBottom = word.bbox.y + word.bbox.h;
    
    let added = false;
    
    // Try to add the word to an existing line (often last line is enough,
    // but overlapping layouts can happen, so scan all lines for safety)
    for (const line of lines) {
      if (isSameLine({ top: line.unionTop, bottom: line.unionBottom }, { top: wTop, bottom: wBottom })) {
        line.words.push(word);
        
        // Update line vertical bounds (union)
        // Tall words expand the capture range for that line
        line.unionTop = Math.min(line.unionTop, wTop);
        line.unionBottom = Math.max(line.unionBottom, wBottom);
        
        // Update avgBottom
        const n = line.words.length;
        line.avgBottom = (line.avgBottom * (n - 1) + wBottom) / n;
        
        added = true;
        break;
      }
    }

    // If it doesn't fit any existing line, create a new line
    if (!added) {
      lines.push({
        words: [word],
        unionTop: wTop,
        unionBottom: wBottom,
        avgBottom: wBottom
      });
    }
  }
  // [Fix] Sort words within each line by X (left)
  // This keeps logged sentences in order and matches intuition
  lines.forEach(line => {
    line.words.sort((a, b) => a.bbox.x - b.bbox.x);
  });
    // [Debug 3]: inspect clustering results (critical)
  // Observe: did one line get split into several?
  // If a single line shows length: 2, isSameLine is too strict.
  console.log('[OCR] Step 2 Clusters:', lines.map(l => ({
    textPreview: l.words.map(w => w.original.text).join(' '), 
    avgBottom: Math.round(l.avgBottom),
    wordCount: l.words.length
  })));


  // ============================================
  // Step 3: choose the "best line"
  // ============================================
  // Logic: find the line whose bottom is above/near the finger
  
  let bestLine: LineGroup | null = null;
  let minLineDist = Infinity;

  for (const line of lines) {
    // Pointer reading rule: finger should be below the text bottom
    // diff > 0: finger below text (normal)
    // diff < 0: finger above text (occluding)
    const distToLineBottom = pointer.y - line.avgBottom;
    // [Debug 4]: inspect line selection logic
    // Observe: why this line? Is distToLineBottom positive or negative?
    // console.log(`[OCR] Checking Line: "${line.words[0].original.text}...", distToBottom: ${distToLineBottom.toFixed(1)}`);


    // Lenient rule: allow finger to cover bottom by 15px (distToLineBottom > -15)
    // But not too far; 50px below likely points to next line's blank area
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
  // Step 4: choose word by edge distance (same as before)
  // ============================================
  let bestWord: NearestWordInfo | null = null;
  let minDx = Infinity;

  // Prepare line context for NearestWordInfo:
  // - linesText: all lines' w.original.text lists (top-to-bottom, left-to-right)
  // - bestLineIndex: indicates the currently selected "best line"
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

