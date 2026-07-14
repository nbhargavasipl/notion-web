"use client";
import { useState, useRef } from "react";

const ACCEPT = ".wav,.mp3,.m4a,.ogg,.flac,.webm,.opus";
const MAX_MB = 9;

type Result = {
  input_language: string;
  translated_transcript: string;
  confidence: number;
};

export default function TryTranscribe({ apiRoute = "/api/transcribe" }: { apiRoute?: string }) {
  const [file,     setFile]     = useState<File | null>(null);
  const [loading,  setLoading]  = useState(false);
  const [result,   setResult]   = useState<Result | null>(null);
  const [error,    setError]    = useState("");
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const pickFile = (f: File) => {
    if (f.size > MAX_MB * 1024 * 1024) { setError(`File too large — max ${MAX_MB} MB`); return; }
    setFile(f); setResult(null); setError("");
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer.files[0]; if (f) pickFile(f);
  };

  const handleTranscribe = async () => {
    if (!file) return;
    setLoading(true); setError(""); setResult(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res  = await fetch(apiRoute, { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.message || data.error || "Transcription failed");
      } else {
        setResult(data);
      }
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Upload zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition ${
          dragging ? "border-white bg-gray-900" : "border-gray-700 hover:border-gray-500"
        }`}
      >
        <input
          ref={inputRef} type="file" accept={ACCEPT} className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) pickFile(f); }}
        />
        {file ? (
          <div>
            <p className="text-white font-medium">{file.name}</p>
            <p className="text-gray-500 text-sm mt-1">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
          </div>
        ) : (
          <div>
            <p className="text-gray-400 mb-1">Drop audio file here or click to browse</p>
            <p className="text-gray-600 text-sm">WAV · MP3 · M4A · OGG · FLAC · WebM — max {MAX_MB} MB</p>
          </div>
        )}
      </div>

      <button
        onClick={handleTranscribe}
        disabled={!file || loading}
        className="bg-white text-black font-semibold text-sm px-6 py-2.5 rounded-lg hover:bg-gray-100 transition disabled:opacity-40 self-start"
      >
        {loading ? "Transcribing…" : "Transcribe"}
      </button>

      {error && (
        <div className="bg-red-950 border border-red-800 rounded-xl px-5 py-4 text-red-300 text-sm">
          {error}
        </div>
      )}

      {result && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <span className="text-xs bg-gray-800 text-gray-300 px-3 py-1 rounded-full">
              Detected: {result.input_language}
            </span>
            <span className="text-xs bg-gray-800 text-gray-300 px-3 py-1 rounded-full">
              Confidence: {Math.round(result.confidence * 100)}%
            </span>
          </div>
          <div className="bg-gray-900 rounded-xl p-5 border border-gray-800">
            <h3 className="text-xs text-gray-500 uppercase tracking-wider mb-3">English Transcript</h3>
            <p className="text-white text-sm leading-relaxed whitespace-pre-wrap">
              {result.translated_transcript}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
