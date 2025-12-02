export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };

declare const cv: any; // OpenCV.js 全局

export function isCVReady(): boolean {
  return typeof (globalThis as any).cv !== "undefined" && !!cv?.Mat;
}

export type HomographyPair = { M: any; Minv: any } | null;

// 计算 curr(当前帧) → ref(参考帧) 的单应，并返回 M 与 Minv
export function computeHomography(curr: Point[], ref: Point[]): HomographyPair {
  if (!isCVReady()) return null;
  if (curr.length !== 4 || ref.length !== 4) return null;
  const ok = [...curr, ...ref].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!ok) return null;
  const srcArr = new Float32Array(curr.flatMap((p) => [p.x, p.y]));
  const dstArr = new Float32Array(ref.flatMap((p) => [p.x, p.y]));
  let M: any = null;
  let Minv: any = null;
  let srcMat: any = null;
  let dstMat: any = null;
  try {
    srcMat = cv.matFromArray(4, 1, cv.CV_32FC2, srcArr);
    dstMat = cv.matFromArray(4, 1, cv.CV_32FC2, dstArr);
    M = cv.getPerspectiveTransform(srcMat, dstMat);
    // 反变换：ref → curr
    const tmpInv = cv.getPerspectiveTransform(dstMat, srcMat);
    Minv = tmpInv;
  } catch {
    try {
      srcMat?.delete?.();
      dstMat?.delete?.();
      const s2 = cv.matFromArray(4, 2, cv.CV_32F, srcArr);
      const d2 = cv.matFromArray(4, 2, cv.CV_32F, dstArr);
      const mask1 = new cv.Mat();
      M = cv.findHomography(s2, d2, 0, 3, mask1);
      const mask2 = new cv.Mat();
      Minv = cv.findHomography(d2, s2, 0, 3, mask2);
      s2.delete();
      d2.delete();
      mask1.delete();
      mask2.delete();
    } catch {
      M = null;
      Minv = null;
    }
  } finally {
    srcMat?.delete?.();
    dstMat?.delete?.();
  }
  if (!M || !Minv) return null;
  return { M, Minv };
}

export function applyHomographyToPoint(H: any, p: Point): Point {
  const denom = H.data64F ? H.data64F : H.data32F;
  // 手动乘以 3x3 矩阵（OpenCV.js 不直接提供单点接口）
  const m = denom as Float64Array | Float32Array;
  const x = p.x, y = p.y;
  const w = m[6] * x + m[7] * y + m[8];
  const nx = (m[0] * x + m[1] * y + m[2]) / w;
  const ny = (m[3] * x + m[4] * y + m[5]) / w;
  return { x: nx, y: ny };
}

export function rectToCorners(r: Rect): Point[] {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
}

export function transformRect(H: any, r: Rect): Point[] {
  const pts = rectToCorners(r);
  return pts.map((p) => applyHomographyToPoint(H, p));
}


