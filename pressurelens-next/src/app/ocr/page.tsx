"use client";

import dynamic from "next/dynamic";

const OCROverlay = dynamic(() => import("../../components/OCROverlay"), { ssr: false });

export default function OCRPage() {
  return (
    <div className="p-4">
      <h1 className="text-xl font-semibold mb-3">OCR 叠加 + 透视配准（Demo）</h1>
      <OCROverlay />
    </div>
  );
}


