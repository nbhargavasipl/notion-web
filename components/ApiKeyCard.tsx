"use client";
import { useState, useTransition } from "react";
import { rotateApiKey } from "@/app/actions";

export default function ApiKeyCard({
  initialKey,
  userId,
}: {
  initialKey: string;
  userId: string;
}) {
  const [apiKey, setApiKey] = useState(initialKey);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isPending, startTransition] = useTransition();

  const displayKey = revealed
    ? apiKey
    : apiKey.slice(0, 8) + "•".repeat(Math.max(0, apiKey.length - 8));

  const handleCopy = async () => {
    await navigator.clipboard.writeText(apiKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRotate = () => {
    if (!confirm("This will invalidate your current key. Continue?")) return;
    startTransition(async () => {
      const newKey = await rotateApiKey(userId);
      if (newKey) {
        setApiKey(newKey);
        setRevealed(true);
      }
    });
  };

  return (
    <div className="bg-gray-900 rounded-xl p-6 border border-gray-800 mb-6">
      <h2 className="font-semibold mb-1">Your API Key</h2>
      <p className="text-gray-500 text-sm mb-4">
        Paste this key into the desktop app Settings screen.
      </p>
      <div className="flex gap-3 items-center mb-3">
        <code className="flex-1 bg-black border border-gray-800 rounded-lg px-4 py-2.5 text-sm text-gray-400 font-mono truncate">
          {displayKey}
        </code>
        <button
          onClick={() => setRevealed(!revealed)}
          className="bg-gray-800 hover:bg-gray-700 text-white text-sm px-4 py-2.5 rounded-lg transition whitespace-nowrap"
        >
          {revealed ? "Hide" : "Reveal"}
        </button>
        <button
          onClick={handleCopy}
          className="bg-gray-800 hover:bg-gray-700 text-white text-sm px-4 py-2.5 rounded-lg transition whitespace-nowrap"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <button
        onClick={handleRotate}
        disabled={isPending}
        className="text-gray-500 hover:text-red-400 text-xs transition disabled:opacity-50"
      >
        {isPending ? "Rotating…" : "Rotate key"}
      </button>
    </div>
  );
}
