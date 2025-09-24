const express = require("express");
const { execSync } = require("child_process");
const fs = require("fs");
const Jimp = require("jimp");
const axios = require("axios");
const { google } = require("googleapis");

const app = express();
const PORT = 5000;

const VIDEO_ID = "yO87jeibrUU";
const WEBHOOK_URL = "https://lukaszlis.app.n8n.cloud/webhook/66d5bc91-6925-41f4-8cc5-93ddc3271aba";

// 🔑 Dane OAuth2
const CLIENT_ID = "511578186990-1bccsua6n2sjqtg5c1mriitd2qmntvmj.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
const REDIRECT_URI = "http://localhost:3000/oauth2callback";

// Wczytujemy refresh_token i access_token z pliku
const tokens = JSON.parse(fs.readFileSync("tokens.json", "utf8"));
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
oauth2Client.setCredentials(tokens);

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

// Pobierz HLS URL z YouTube API
async function getHLSUrl() {
  const youtube = google.youtube("v3");
  const res = await youtube.videos.list({
    part: "liveStreamingDetails",
    id: VIDEO_ID,
    auth: oauth2Client,
  });

  const liveDetails = res.data.items?.[0]?.liveStreamingDetails;
  if (!liveDetails || !liveDetails.hlsManifestUrl) {
    throw new Error("❌ Brak HLS URL w szczegółach streamu");
  }
  return liveDetails.hlsManifestUrl;
}

// Pobiera jedną klatkę z HLS
async function captureFrame(outPath) {
  const hlsUrl = await getHLSUrl();
  execSync(`ffmpeg -y -i "${hlsUrl}" -frames:v 1 -q:v 2 "${outPath}"`, {
    stdio: "ignore",
  });

  if (!fs.existsSync(outPath)) throw new Error("ffmpeg nie wygenerował pliku klatki");

  console.log("✅ Frame captured:", outPath);
}

// Analiza obrazu i OCR przez Google Vision
async function analyzeImage(path) {
  const image = await Jimp.read(path);
  const width = image.bitmap.width;
  const height = image.bitmap.height;

  // 🔥 Wycinamy obszar: prawa 35% szerokości i dolne 70% wysokości
  const cropX = Math.floor(width * 0.65);
  const cropY = Math.floor(height * 0.3);
  const cropWidth = Math.floor(width * 0.35);
  const cropHeight = Math.floor(height * 0.7);

  const crop = image.clone().crop(cropX, cropY, cropWidth, cropHeight);
  const tmpPath = `crop_${Date.now()}.png`;
  await crop.writeAsync(tmpPath);

  try {
    const imageBase64 = fs.readFileSync(tmpPath, "base64");
    const res = await axios.post(
      `https://vision.googleapis.com/v1/images:annotate?key=${process.env.GOOGLE_API_KEY}`,
      {
        requests: [
          {
            image: { content: imageBase64 },
            features: [{ type: "TEXT_DETECTION" }],
          },
        ],
      }
    );

    const detections = res.data.responses?.[0]?.textAnnotations || [];
    if (detections.length === 0) return null;

    const rawText = detections.map((d) => d.description).join(" ").toLowerCase();
    console.log("🔎 OCR detected text:", rawText);

    const signals = [];
    const words = rawText.split(/\s+/);

    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w.includes("buy")) signals.push("Buy Sygnał");
      else if (w.includes("sell") || w.includes("short")) signals.push("Sell Sygnał");
      else if (w.includes("take") && words[i + 1] && words[i + 1].includes("profit")) {
        signals.push("Take Profit Sygnał");
        i++;
      }
    }

    const last = signals.length > 0 ? signals[signals.length - 1] : null;
    return last ? { type: last, text: rawText } : null;
  } finally {
    safeUnlink(tmpPath);
  }
}

// Funkcja analizy
async function runAnalysis() {
  const tmpPath = "frame.jpg";
  try {
    console.log("⏳ Pobieram nową klatkę z YouTube...");
    await captureFrame(tmpPath);

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
      console.log("📢 Nowy ostatni sygnał:", signal);
      return signal;
    }
  } catch (err) {
    console.error("❌ Błąd analizy:", err.message);
    return null;
  } finally {
    safeUnlink(tmpPath);
  }
}

// Automatyczna analiza co 2 minuty
async function startAutoAnalysis() {
  const intervalMs = 2 * 60 * 1000;
  async function loop() {
    try {
      const signal = await runAnalysis();
      if (signal) {
        try {
          await axios.post(WEBHOOK_URL, signal);
          console.log("✅ Sygnał wysłany do webhooka");
        } catch (err) {
          console.error("❌ Błąd wysyłki sygnału:", err.message);
        }
      }
    } catch (err) {
      console.error("❌ Błąd w pętli analizy:", err.message);
    } finally {
      setTimeout(loop, intervalMs);
    }
  }
  loop();
}

// Endpoint ręczny
app.post("/analyze", async (req, res) => {
  const signal = await runAnalysis();
  res.json({ ok: true, signal });
});

app.listen(PORT, () => {
  console.log(`🚀 Analyzer ready at http://localhost:${PORT}`);
  startAutoAnalysis();
});
