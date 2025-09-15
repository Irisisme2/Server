const express = require("express");
const { execSync } = require("child_process");
const fs = require("fs");
const Jimp = require("jimp");
const axios = require("axios");

const app = express();
const PORT = 5000;

const YOUTUBE_URL = "https://www.youtube.com/watch?v=yO87jeibrUU";
const GOOGLE_API_KEY = "AIzaSyAwnT2lqzCBJi2wBbUi6zdeXnzuiX6E2Cs";

// Pamięć ostatniego wysłanego sygnału
let lastSentSignal = null;

// Bezpieczne usuwanie pliku
function safeUnlink(path) {
  if (fs.existsSync(path)) {
    try {
      fs.unlinkSync(path);
    } catch (e) {
      console.warn(`⚠️ Nie udało się usunąć ${path}:`, e.message);
    }
  }
}

// Pobiera jedną klatkę z YouTube Live z retry
function captureFrame(outPath, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const urls = execSync(`yt-dlp -g ${YOUTUBE_URL}`, { encoding: "utf8" })
        .trim()
        .split("\n");
      if (!urls.length) throw new Error("yt-dlp nie zwrócił żadnego URL");

      const streamUrl = urls[0];
      execSync(
        `ffmpeg -y -i "${streamUrl}" -frames:v 1 -q:v 2 "${outPath}"`,
        { stdio: "ignore" }
      );

      if (!fs.existsSync(outPath)) throw new Error("ffmpeg nie wygenerował pliku klatki");

      console.log("✅ Frame captured:", outPath);
      return;
    } catch (err) {
      console.warn(`⚠️ Próba ${i + 1} nieudana: ${err.message}`);
      if (i === retries - 1) throw new Error("Failed to capture frame from YouTube");
    }
  }
}

// Analiza obrazu i OCR przez Google Vision
async function analyzeImage(path) {
  const image = await Jimp.read(path);
  const width = image.bitmap.width;
  const height = image.bitmap.height;

  // Bierzemy 50% szerokości
  const crop = image.clone().crop(Math.floor(width * 0.5), 0, Math.floor(width * 0.5), height);
  const tmpPath = `crop_${Date.now()}.png`;
  await crop.writeAsync(tmpPath);

  try {
    const imageBase64 = fs.readFileSync(tmpPath, "base64");
    const res = await axios.post(
      `https://vision.googleapis.com/v1/images:annotate?key=${GOOGLE_API_KEY}`,
      {
        requests: [
          {
            image: { content: imageBase64 },
            features: [{ type: "TEXT_DETECTION" }]
          }
        ]
      }
    );

    const detections = res.data.responses?.[0]?.textAnnotations || [];
    if (detections.length === 0) return null;

    const rawText = detections.map(d => d.description).join(" ").toLowerCase();
    console.log("🔎 OCR detected text:", rawText);

    // Wyłuskujemy sygnały w kolejności pojawienia się
  // Wyłuskujemy sygnały w kolejności pojawienia się
const signals = [];
const words = rawText.split(/\s+/);

for (let i = 0; i < words.length; i++) {
  const w = words[i];
  const next = words[i + 1] || "";

  if (w.includes("buy")) {
    signals.push("Buy Sygnał");
  } else if (w.includes("sell") || w.includes("short")) {
    signals.push("Sell Sygnał");
  } else if (/(tak[el]?|taek)/.test(w) && /(pro[fv]it|prefit)/.test(next)) {
    // Obsługa literówek "takle", "taek", "prefit"
    signals.push("Take Profit Sygnał");
    i++; // pomijamy "profit"/"prefit"
  }
}


    // Bierzemy ostatni sygnał w kolejności
    const last = signals.length > 0 ? signals[signals.length - 1] : null;
    return last ? { type: last, text: rawText } : null;
  } finally {
    safeUnlink(tmpPath);
  }
}

// Funkcja analizy (wywoływana w endpoint)
async function runAnalysis() {
  const tmpPath = "frame.jpg";
  try {
    console.log("⏳ Pobieram nową klatkę z YouTube...");
    captureFrame(tmpPath);

    const signal = await analyzeImage(tmpPath);

    if (!signal) {
      console.log("ℹ️ Brak sygnału w tej klatce.");
      return null;
    }

    console.log("📡 Ostatni sygnał na wykresie:", signal.type);

    // Wysyłamy tylko jeśli ostatni sygnał jest nowy w stosunku do poprzednio wysłanego
    if (signal.type === lastSentSignal) {
      console.log("⚠️ Ostatni sygnał nie zmienił się → pomijamy");
      return null;
    } else {
      lastSentSignal = signal.type;
      console.log("📢 Nowy ostatni sygnał wysyłany:", signal);
      return signal;
    }
  } catch (err) {
    console.error("❌ Błąd analizy:", err.message);
    return null;
  } finally {
    safeUnlink(tmpPath);
  }
}

// Endpoint ręczny – wywoływany np. z n8n
app.post("/analyze", async (req, res) => {
  const signal = await runAnalysis();
  res.json({ ok: true, signal });
});

app.listen(PORT, () => {
  console.log(`🚀 Analyzer ready at http://localhost:${PORT}`);
});
