export type WordBBox = {
  text: string;
  bbox: { x: number; y: number; w: number; h: number };
};

// 动态加载，避免 SSR 触发
export async function recognizeWordsFromCanvas(
  canvas: HTMLCanvasElement,
  lang: string = "eng"
): Promise<WordBBox[]> {
  const Tesseract = (await import("tesseract.js")).default as any;
  const dataUrl = canvas.toDataURL("image/png");
  const { data } = await Tesseract.recognize(dataUrl, lang);

  const words: WordBBox[] = [];
  const blocks = (data as any).blocks ?? [];
  for (const block of blocks) {
    for (const par of block.paragraphs ?? []) {
      for (const line of par.lines ?? []) {
        for (const word of line.words ?? []) {
          const b = word.bbox; // {x0,y0,x1,y1}
          words.push({
            text: word.text,
            bbox: { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 },
          });
        }
      }
    }
  }
  return words;
}


