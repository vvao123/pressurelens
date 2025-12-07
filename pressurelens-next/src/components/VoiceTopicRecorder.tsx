"use client";

import { useRef, useState } from "react";
import type { VoiceAnnotation } from "../lib/logging/types";

type Props = {
  onAnnotation: (ann: VoiceAnnotation) => void;
};

export default function VoiceTopicRecorder({ onAnnotation }: Props) {
  const [isRecording, setIsRecording] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lastTranscript, setLastTranscript] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  // 暂存一次完整的语音注释，让用户可以选择「保存」或「重说」
  const [pendingAnnotation, setPendingAnnotation] = useState<VoiceAnnotation | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef<number>(0);

  const startRecording = async () => {
    try {
      setError(null);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      mediaRecorderRef.current = mr;
      chunksRef.current = [];
      startTimeRef.current = Date.now();

      mr.ondataavailable = (e: BlobEvent) => {
        if (e.data && e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      mr.onstop = async () => {
        const endTime = Date.now();
        const firstType = chunksRef.current[0]?.type || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: firstType });
        if (blob.size === 0) {
          setError("empty audio, please try again");
          return;
        }

        setIsSubmitting(true);
        try {
          const file = new File([blob], "speech.webm", { type: blob.type });
          const form = new FormData();
          form.append("audio", file);

          const res = await fetch("/api/voice-stt", {
            method: "POST",
            body: form,
          });

          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            console.error("[VoiceTopicRecorder] /api/voice-stt error", res.status, txt);
            setError(`STT error: ${res.status}`);
            return;
          }

          const data = await res.json();
          const transcript: string = data?.transcript || "";
          setLastTranscript(transcript);

          if (transcript) {
            const ann: VoiceAnnotation = {
              id: `voice-${startTimeRef.current}-${Math.random()
                .toString(36)
                .slice(2, 8)}`,
              timestampStart: startTimeRef.current,
              timestampEnd: endTime,
              transcript,
            };
            // 不立刻提交给上层，而是暂存在本地，等用户确认或选择重说
            setPendingAnnotation(ann);
          }
        } catch (e: any) {
          console.error("[VoiceTopicRecorder] unexpected error", e);
          setError(e?.message || String(e));
        } finally {
          setIsSubmitting(false);
        }
      };

      mr.start();
      setIsRecording(true);
    } catch (e: any) {
      console.error("[VoiceTopicRecorder] failed to start recording", e);
      setError(e?.message || String(e));
    }
  };

  const stopRecording = () => {
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== "inactive") {
      mr.stop();
      mr.stream.getTracks().forEach((t) => t.stop());
    }
    setIsRecording(false);
  };

  const toggleRecording = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  const handleSave = () => {
    if (!pendingAnnotation) return;
    onAnnotation(pendingAnnotation);
    setPendingAnnotation(null);
  };

  const handleRedo = () => {
    // 丢弃当前这次识别结果，让用户重新按住说
    setPendingAnnotation(null);
    setLastTranscript("");
    setError(null);
  };

  return (
    <div className="flex flex-col gap-1 text-xs text-gray-700 max-w-xs">
      <div className="flex items-center gap-2">
        <span className="text-gray-600 whitespace-nowrap">voice topic:</span>
        <button
          onClick={toggleRecording}
          disabled={isSubmitting}
          className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
            isRecording
              ? "bg-red-500 text-white"
              : "bg-gray-200 text-gray-800 hover:bg-gray-300"
          }`}
        >
          {isRecording ? "● recording..." : "🎙️ press to speak"}
        </button>
        {isSubmitting && (
          <span className="text-gray-500 ml-1">transcribing...</span>
        )}
      </div>
      {lastTranscript && pendingAnnotation && (
        <div className="flex items-start gap-2 text-[11px] text-gray-600">
          <div className="flex-1 line-clamp-2">
            last: <span className="italic">{lastTranscript}</span>
          </div>
          <div className="flex flex-col gap-1">
            <button
              type="button"
              onClick={handleSave}
              className="px-10 py-0.5 rounded bg-green-500 text-white text-[10px] hover:bg-green-600"
            >
              save
            </button>
            <button
              type="button"
              onClick={handleRedo}
              className="px-10 py-0.5 rounded bg-gray-200 text-gray-700 text-[10px] hover:bg-gray-300"
            >
              redo
            </button>
          </div>
        </div>
      )}
      {error && (
        <div className="text-[11px] text-red-500">
          {error}
        </div>
      )}
    </div>
  );
}


