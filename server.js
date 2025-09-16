const express = require("express");
const { execSync } = require("child_process");
const fs = require("fs");
const Jimp = require("jimp");
const axios = require("axios");

const app = express();
const PORT = 5000;

const VIDEO_ID = "yO87jeibrUU";
const GOOGLE_API_KEY = "AIzaSyAu218u362XsRcNxTqtg1bIqbVqB8yFGyU";

let lastSentSignal = null;

function safeUnlink(path) {
  if (fs.existsSync(path)) {
    try { fs.unlinkSync(path); } 
    catch (e) { console.warn(`⚠️ Nie udało się usunąć ${path}:`, e.message); }
  }
}

// Pobranie URL HLS publicznego streamu przez YouTube Data API
async function getHLSUrl() {
  const res = await axios.get(`https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${VIDEO_ID}&key=${GOOGLE_API_KEY}`);
  const liveDetails = res.data.items?.[0]?.liveStreamingDetails;
  if (!liveDetails || !liveDetails.hlsManifestUrl) {
    throw new Error("❌ Brak HLS URL w szczegółach streamu");
  }
  return liveDetails.hlsManifestUrl;
}

// Wyciągnięcie klatki z HLS
function captureFrame(outPath, hlsUrl) {
  execSync(`ffmpeg -y -i "${hlsUrl}" -frames:v 1 -q:v 2 "${outPath}"`, { stdio: "ignore" });
  if (!fs.existsSync(outPath)) throw new Error("ffmpeg nie wygenerował pliku klatki");
  console.log("✅ Frame captured:", outPath);
}

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

    // Wyłuskujemy sygnały
    const signals = [];
    const words = rawText.split(/\s+/);

    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const next = words[i + 1] || "";

      if (w.includes("buy")) signals.push("Buy Sygnał");
      else if (w.includes("sell") || w.includes("short")) signals.push("Sell Sygnał");
      else if (/(tak[el]?|taek)/.test(w) && /(pro[fv]it|prefit)/.test(next)) {
        signals.push("Take Profit Sygnał");
        i++; // pomijamy "profit"/"prefit"
      }
    }

    // Bierzemy ostatni sygnał
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

    // Pobranie HLS URL
    const hlsUrl = await getHLSUrl();

    // Teraz przekazujemy URL do captureFrame
    captureFrame(tmpPath, hlsUrl);

    const signal = await analyzeImage(tmpPath);

    if (!signal) {
      console.log("ℹ️ Brak sygnału w tej klatce.");
      return null;
    }

    console.log("📡 Ostatni sygnał na wykresie:", signal.type);

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
