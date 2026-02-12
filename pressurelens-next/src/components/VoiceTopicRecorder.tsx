"use client";

import { useEffect, useRef, useState } from "react";
import { sessionLogger } from "../lib/logging/sessionLogger";
import type { RejectedVoiceAnnotation, VoiceAnnotation } from "../lib/logging/types";

type Props = {
  onAnnotation: (ann: VoiceAnnotation) => void;
};

export default function VoiceTopicRecorder({ onAnnotation }: Props) {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isContinuousListening, setIsContinuousListening] = useState(false);
  const [lastTranscript, setLastTranscript] = useState<string>("");
  const [lastTranscriptRaw, setLastTranscriptRaw] = useState<string>("");
  const [lastAutoSavedAt, setLastAutoSavedAt] = useState<number | null>(null);
  const [lastListenStatus, setLastListenStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [activationPhrase, setActivationPhrase] = useState("intention");
  const [speechThreshold, setSpeechThreshold] = useState(0.015);
  // Stash a full voice annotation so the user can save or redo
  const [pendingAnnotation, setPendingAnnotation] = useState<VoiceAnnotation | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const speechCheckTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasSpeechRef = useRef<boolean>(false);
  const chunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef<number>(0);
  const queuedChunkRef = useRef<Array<{ blob: Blob; start: number; end: number }>>([]);
  const recordingModeRef = useRef<"manual" | "continuous" | null>(null);
  const lastActivationAtRef = useRef<number>(0);
  const isTranscribingRef = useRef<boolean>(false);
  const continuousTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const continuousStopCheckRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSpeechAtRef = useRef<number>(0);
  const pendingAudioBlobRef = useRef<Blob | null>(null);

  const stopRecorder = (stopStream = true, clearMode = true) => {
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== "inactive") {
      mr.stop();
      if (stopStream) {
        mr.stream.getTracks().forEach((t) => t.stop());
      }
    }
    mediaRecorderRef.current = null;
    if (clearMode) {
      recordingModeRef.current = null;
    }
    queuedChunkRef.current = [];
    if (continuousTimerRef.current) {
      clearTimeout(continuousTimerRef.current);
      continuousTimerRef.current = null;
    }
    if (continuousStopCheckRef.current) {
      clearInterval(continuousStopCheckRef.current);
      continuousStopCheckRef.current = null;
    }
    if (stopStream && mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    if (speechCheckTimerRef.current) {
      clearInterval(speechCheckTimerRef.current);
      speechCheckTimerRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => undefined);
      audioContextRef.current = null;
    }
    analyserRef.current = null;
  };

  const setupSpeechDetection = (stream: MediaStream) => {
    if (audioContextRef.current) return;
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    const ctx = new AudioCtx();
    audioContextRef.current = ctx;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    const source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);
    analyserRef.current = analyser;
    const data = new Uint8Array(analyser.fftSize);
    speechCheckTimerRef.current = setInterval(() => {
      if (!analyserRef.current) return;
      analyserRef.current.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      if (rms > speechThreshold) {
        hasSpeechRef.current = true;
        lastSpeechAtRef.current = Date.now();
      }
    }, 200);
  };

  const isTranscriptNoise = (transcript: string) => {
    const trimmed = transcript.trim();
    if (trimmed.length < 1) return true;
    if (!/[a-zA-Z\u4e00-\u9fff]/.test(trimmed)) return true;
    const compact = trimmed.replace(/\s+/g, "");
    const uniqueChars = new Set(compact.split(""));
    if (compact.length >= 4 && uniqueChars.size <= 1) return true;
    return false;
  };

  const isJapaneseTranscript = (transcript: string) => /[\u3040-\u30ff]/.test(transcript);
  const normalizeForMatch = (text: string) =>
    text
      .toLowerCase()
      .replace(/[\s.,!?，。！？、:;'"“”‘’()[\]{}<>-]/g, "");

  const findWakeWordDetectedAt = (
    segments: any[] | undefined,
    phrase: string,
    timestampStart: number
  ): number | undefined => {
    if (!segments || !Array.isArray(segments)) return undefined;
    const np = normalizeForMatch(phrase);
    if (!np) return undefined;
    for (const seg of segments) {
      const t = typeof seg?.text === "string" ? seg.text : "";
      const ns = normalizeForMatch(t);
      if (!ns || !ns.includes(np)) continue;
      const startSec = typeof seg?.start === "number" ? seg.start : undefined;
      if (startSec === undefined) return undefined;
      const endSec = typeof seg?.end === "number" ? seg.end : undefined;
      const idx = ns.indexOf(np);
      // If we have segment end and can locate the wake word position, estimate within the segment.
      // This avoids the common case where Whisper returns a single segment starting at 0.
      if (endSec !== undefined && endSec > startSec && idx >= 0 && ns.length > 0) {
        const rel = idx / ns.length;
        const estSec = startSec + rel * (endSec - startSec);
        return timestampStart + Math.max(0, Math.floor(estSec * 1000));
      }
      return timestampStart + Math.max(0, Math.floor(startSec * 1000));
        }
    return undefined;
      };

  const cleanAfterWakeWord = (
    raw: string,
    phrase: string
  ): { cleaned: string; wakeTokenStartIndex: number; wakeTokenEndIndex: number } | null => {
    const p = phrase.trim();
    if (!p) return null;
    const rawLower = raw.toLowerCase();
    const pLower = p.toLowerCase();
    const idx = rawLower.indexOf(pLower);
    if (idx < 0) return null;

    // Remove the token that CONTAINS the phrase (e.g. intention -> remove "intentional"),
    // and remove everything BEFORE it as well.
    const isAsciiWake = /^[a-z0-9_]+$/.test(normalizeForMatch(p));
    let cutEnd = idx + p.length;
    let tokenStart = idx;
    if (isAsciiWake) {
      const isWordChar = (ch: string) => /[a-z0-9_]/.test(ch);
      // expand to token boundaries on original string
      let s = idx;
      while (s > 0 && isWordChar(rawLower[s - 1])) s -= 1;
      let e = idx + p.length;
      while (e < rawLower.length && isWordChar(rawLower[e])) e += 1;
      tokenStart = s;
      cutEnd = e;
    }

    let out = raw.slice(cutEnd);
    out = out.replace(/^[\s.,!?，。！？、:;'"“”‘’()[\]{}<>-]+/, "");
    out = out.trim();
    if (!out) return null;
    return { cleaned: out, wakeTokenStartIndex: tokenStart, wakeTokenEndIndex: cutEnd };
  };

  const handleTranscript = (
    transcript: string,
    timestampStart: number,
    timestampEnd: number,
    blob?: Blob,
    segments?: any[]
  ) => {
    if (!transcript) return;
    const isContinuousMode = recordingModeRef.current === "continuous";
    if (isTranscriptNoise(transcript)) {
      if (!isContinuousMode) {
        setError("no clear speech detected, please try again");
      } else {
        setLastListenStatus("filtered: noise");
      }
      return;
    }
    if (isJapaneseTranscript(transcript)) {
      if (!isContinuousMode) {
        setError("non-target language detected, please try again");
      } else {
        setLastListenStatus("filtered: japanese");
      }
      return;
    }

    const phrase = activationPhrase.trim();
    const normalizedTranscript = normalizeForMatch(transcript);
    const normalizedPhrase = normalizeForMatch(phrase);
    const hasActivation =
      normalizedPhrase.length > 0 && normalizedTranscript.includes(normalizedPhrase);
    if (isContinuousMode && !hasActivation) {
      // Save for later audit (to catch STT misses of the wake word).
      setLastTranscriptRaw(transcript);
      setLastTranscript(transcript);
      setLastListenStatus("wake word not detected (saved for review)");
      if (blob) {
        const rej: RejectedVoiceAnnotation = {
          id: `voice-rejected-${timestampStart}-${Math.random().toString(36).slice(2, 8)}`,
          timestampStart,
          timestampEnd,
          transcript,
          rejectedReason: "wake_word_not_detected",
          wakeWord: phrase,
        };
        sessionLogger.addRejectedVoiceAnnotation(rej);
        sessionLogger.addRejectedVoiceAudio(rej.id, blob);
      }
          return;
        }

    const now = Date.now();
    if (isContinuousMode && now - lastActivationAtRef.current < 3000) return;
    if (isContinuousMode) lastActivationAtRef.current = now;

    const rawTranscript = transcript;
    let finalTranscript = transcript.trim();
    if (hasActivation) {
      const cleaned = cleanAfterWakeWord(rawTranscript, phrase);
      if (!cleaned) return;
      finalTranscript = cleaned.cleaned;
    }

    const computedWakeAt =
      hasActivation
        ? findWakeWordDetectedAt(segments, phrase, timestampStart) ?? timestampEnd
        : undefined;

    if (hasActivation && isContinuousMode) {
      // Debug wake timing: compare computed wake timestamp vs chunk start/end.
      console.debug("[VoiceTopicRecorder][wake]", {
        phrase,
        timestampStart,
        timestampEnd,
        computedWakeAt,
        deltaFromStartMs: computedWakeAt ? computedWakeAt - timestampStart : null,
        deltaToEndMs: computedWakeAt ? timestampEnd - computedWakeAt : null,
        segmentsPreview: Array.isArray(segments)
          ? segments.slice(0, 6).map((s: any) => ({
              start: s?.start,
              end: s?.end,
              text: s?.text,
            }))
          : null,
      });
    }

    const ann: VoiceAnnotation = {
      id: `voice-${timestampStart}-${Math.random().toString(36).slice(2, 8)}`,
      timestampStart,
      timestampEnd,
      transcript: finalTranscript,
      rawTranscript,
      ...(hasActivation ? { wakeWordDetectedAt: computedWakeAt } : {}),
    };
    if (blob) {
      pendingAudioBlobRef.current = blob;
    }
    setLastTranscriptRaw(transcript);
    setLastTranscript(finalTranscript);
    if (isContinuousMode) {
      onAnnotation(ann);
      if (blob) {
        sessionLogger.addVoiceAudio(ann.id, blob);
      }
      setPendingAnnotation(null);
      pendingAudioBlobRef.current = null;
      setLastAutoSavedAt(Date.now());
      setLastListenStatus("wake word detected → auto saved");
      return;
    }
    setLastAutoSavedAt(null);
    // Don't submit immediately; store locally for user confirmation or redo
    setPendingAnnotation((prev) => prev ?? ann);
  };

  const transcribeBlob = async (blob: Blob, timestampStart: number, timestampEnd: number) => {
    if (blob.size === 0) return;
    isTranscribingRef.current = true;
    setIsTranscribing(true);
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
      const segments = Array.isArray(data?.segments) ? data.segments : undefined;
      handleTranscript(transcript, timestampStart, timestampEnd, blob, segments);
        } catch (e: any) {
          console.error("[VoiceTopicRecorder] unexpected error", e);
          setError(e?.message || String(e));
        } finally {
      isTranscribingRef.current = false;
      setIsTranscribing(false);
      if (queuedChunkRef.current.length > 0) {
        const queued = queuedChunkRef.current.shift();
        if (queued) {
          transcribeBlob(queued.blob, queued.start, queued.end);
        }
      }
    }
  };

  const startRecording = async () => {
    try {
      setError(null);
      stopRecorder(true, true);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      setupSpeechDetection(stream);
      const mr = new MediaRecorder(stream);
      mediaRecorderRef.current = mr;
      chunksRef.current = [];
      startTimeRef.current = Date.now();
      recordingModeRef.current = "manual";
      hasSpeechRef.current = false;

      mr.ondataavailable = (e: BlobEvent) => {
        if (recordingModeRef.current !== "manual") return;
        if (e.data && e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      mr.onstop = async () => {
        if (recordingModeRef.current !== "manual") return;
        const endTime = Date.now();
        const firstType = chunksRef.current[0]?.type || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: firstType });
        if (blob.size === 0) {
          setError("empty audio, please try again");
          recordingModeRef.current = null;
          return;
        }
        if (!hasSpeechRef.current) {
          setError("no clear speech detected, please try again");
          recordingModeRef.current = null;
          return;
        }
        hasSpeechRef.current = false;
        await transcribeBlob(blob, startTimeRef.current, endTime);
        recordingModeRef.current = null;
      };

      mr.start();
      setIsRecording(true);
    } catch (e: any) {
      console.error("[VoiceTopicRecorder] failed to start recording", e);
      setError(e?.message || String(e));
    }
  };

  const stopRecording = () => {
    stopRecorder(true, false);
    setIsRecording(false);
  };

  const toggleRecording = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  const startContinuousListening = async () => {
    try {
      setError(null);
      stopRecorder(true, true);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      setupSpeechDetection(stream);
      recordingModeRef.current = "continuous";
      queuedChunkRef.current = [];
      queuedChunkRef.current = [];
      setPendingAnnotation(null);
      setLastAutoSavedAt(null);
      setLastListenStatus("listening...");

      const startContinuousCycle = () => {
        if (recordingModeRef.current !== "continuous" || !mediaStreamRef.current) return;
        const mr = new MediaRecorder(mediaStreamRef.current);
        mediaRecorderRef.current = mr;
        chunksRef.current = [];
        const chunkStart = Date.now();
        hasSpeechRef.current = false;
        lastSpeechAtRef.current = chunkStart;

        mr.ondataavailable = (e: BlobEvent) => {
          if (recordingModeRef.current !== "continuous") return;
          if (e.data && e.data.size > 0) {
            chunksRef.current.push(e.data);
          }
        };

        mr.onstop = () => {
          if (recordingModeRef.current !== "continuous") return;
          if (continuousStopCheckRef.current) {
            clearInterval(continuousStopCheckRef.current);
            continuousStopCheckRef.current = null;
          }
          const endTime = Date.now();
          const firstType = chunksRef.current[0]?.type || "audio/webm";
          const blob = new Blob(chunksRef.current, { type: firstType });
          if (blob.size > 0 && hasSpeechRef.current) {
            if (isTranscribingRef.current) {
              queuedChunkRef.current.push({ blob, start: chunkStart, end: endTime });
              // Safety cap to avoid unbounded memory growth if STT can't keep up
              const maxQueue = 12;
              if (queuedChunkRef.current.length > maxQueue) {
                queuedChunkRef.current.shift();
                setLastListenStatus(`queue overflow (dropped oldest), q=${queuedChunkRef.current.length}`);
              }
            } else {
              transcribeBlob(blob, chunkStart, endTime);
            }
            setLastListenStatus("transcribing...");
          } else {
            setLastListenStatus("no speech");
          }
          hasSpeechRef.current = false;
          startContinuousCycle();
        };

        mr.start();
        const maxChunkMs = 8000;
        const silenceStopMs = 2000;
        continuousTimerRef.current = setTimeout(() => {
          // Max duration reached, wait for short silence before stopping.
          if (continuousStopCheckRef.current) {
            clearInterval(continuousStopCheckRef.current);
          }
          continuousStopCheckRef.current = setInterval(() => {
            const now = Date.now();
            const silentFor = now - lastSpeechAtRef.current;
            if (silentFor >= silenceStopMs) {
              if (mr.state !== "inactive") mr.stop();
            }
          }, 200);
        }, maxChunkMs);
      };

      startContinuousCycle();
      setIsContinuousListening(true);
    } catch (e: any) {
      console.error("[VoiceTopicRecorder] failed to start continuous listening", e);
      setError(e?.message || String(e));
    }
  };

  const stopContinuousListening = () => {
    stopRecorder(true);
    setIsContinuousListening(false);
  };

  const toggleContinuousListening = () => {
    if (isContinuousListening) {
      stopContinuousListening();
    } else {
      if (isRecording) stopRecording();
      startContinuousListening();
    }
  };

  const handleSave = () => {
    if (!pendingAnnotation) return;
    onAnnotation(pendingAnnotation);
    if (pendingAudioBlobRef.current) {
      sessionLogger.addVoiceAudio(pendingAnnotation.id, pendingAudioBlobRef.current);
      pendingAudioBlobRef.current = null;
    }
    setPendingAnnotation(null);
  };

  const handleRedo = () => {
    // Discard current recognition result and let the user record again
    setPendingAnnotation(null);
    pendingAudioBlobRef.current = null;
    setLastTranscript("");
    setError(null);
  };

  useEffect(() => {
    return () => {
      stopRecorder();
    };
  }, []);

  return (
    <div className="flex flex-col gap-1 text-xs text-gray-700 max-w-xs">
      <div className="flex items-center gap-2">
        <span className="text-gray-600 whitespace-nowrap">voice topic:</span>
        <button
          onClick={toggleRecording}
          disabled={isTranscribing || isContinuousListening}
          className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
            isRecording
              ? "bg-red-500 text-white"
              : "bg-gray-200 text-gray-800 hover:bg-gray-300"
          }`}
        >
          {isRecording ? "● recording..." : "🎙️ press to speak"}
        </button>
        <button
          onClick={toggleContinuousListening}
          className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
            isContinuousListening
              ? "bg-purple-500 text-white"
              : "bg-gray-200 text-gray-800 hover:bg-gray-300"
          }`}
        >
          {isContinuousListening ? "👂 listening..." : "🟣 always listen"}
        </button>
        {isTranscribing && (
          <span className="text-gray-500 ml-1">transcribing...</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-gray-500 whitespace-nowrap">wake word:</span>
        <input
          value={activationPhrase}
          onChange={(e) => setActivationPhrase(e.target.value)}
          className="px-2 py-0.5 text-xs border border-gray-200 rounded w-32"
          placeholder="intention"
        />
        <span className="text-[10px] text-gray-400">
          {isContinuousListening ? "say wake word to create label" : "for always listen mode"}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-gray-500 whitespace-nowrap">speech sensitivity:</span>
        <input
          type="range"
          min={0.005}
          max={0.06}
          step={0.001}
          value={speechThreshold}
          onChange={(e) => setSpeechThreshold(Number(e.target.value))}
        />
        <span className="text-[10px] text-gray-400 w-10 text-right">
          {speechThreshold.toFixed(3)}
        </span>
      </div>
      {lastTranscript && (
        <div className="flex items-start gap-2 text-[11px] text-gray-600">
          <div className="flex-1">
            <div className="line-clamp-2">
            last: <span className="italic">{lastTranscript}</span>
            </div>
            {lastTranscriptRaw && lastTranscriptRaw !== lastTranscript && (
              <div className="text-[10px] text-gray-400 line-clamp-2">
                raw: {lastTranscriptRaw}
              </div>
            )}
          </div>
          {pendingAnnotation && !isContinuousListening ? (
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
          ) : (
            lastAutoSavedAt && (
              <span className="text-[10px] text-green-600 whitespace-nowrap">auto saved</span>
            )
          )}
        </div>
      )}
      {isContinuousListening && lastListenStatus && (
        <div className="text-[10px] text-gray-500">status: {lastListenStatus}</div>
      )}
      {error && (
        <div className="text-[11px] text-red-500">
          {error}
        </div>
      )}
    </div>
  );
}


