// server.js
const express = require("express");
const { execSync } = require("child_process");
const fs = require("fs");
const Jimp = require("jimp");
const axios = require("axios");

const app = express();
const PORT = 5000;

const VIDEO_ID = "yO87jeibrUU";
const GOOGLE_API_KEY = "AIzaSyAu218u362XsRcNxTqtg1bIqbVqB8yFGyU";

// Ścieżka do pliku cookies (Netscape format) — zmień jeśli trzymasz gdzie indziej
const YT_COOKIES_PATH = "./www.youtube.com_cookies.txt";

let lastSentSignal = null;

function safeUnlink(path) {
  if (fs.existsSync(path)) {
    try { fs.unlinkSync(path); } 
    catch (e) { console.warn(`⚠️ Nie udało się usunąć ${path}:`, e.message); }
  }
}

// --- NOWA implementacja: pobranie HLS URL przez yt-dlp + cookies ---
function getHLSUrlViaYtdlp(videoId) {
  if (!fs.existsSync(YT_COOKIES_PATH)) {
    throw new Error(`Brak pliku cookies: ${YT_COOKIES_PATH}. Wgraj cookies (Netscape) z zalogowanej przeglądarki.`);
  }

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  try {
    // uruchamiamy yt-dlp -g --cookies "plik" "url"
    // -g wypisuje bezpośrednie URL-e (może być kilka linii)
    const cmd = `yt-dlp -g --cookies "${YT_COOKIES_PATH}" "${videoUrl}"`;
    const out = execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    if (!out) throw new Error("yt-dlp nie zwrócił żadnego URL (pusty output).");

    const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    // wybieramy pierwszego .m3u8 jeśli jest, inaczej pierwszy URL
    const hls = lines.find(l => l.includes(".m3u8")) || lines[0];

    if (!hls) throw new Error("Nie znaleziono URL HLS w wyjściu yt-dlp.");
    return hls;
  } catch (e) {
    // jeśli yt-dlp wypisał na stderr informacje, tu pokażemy sensowny komunikat
    const msg = e.message || String(e);
    throw new Error(`yt-dlp error: ${msg}`);
  }
}

// Wyciągnięcie klatki z HLS
function captureFrame(outPath, hlsUrl) {
  // Upewniamy się, że URL nie zawiera nowej linii itp.
  const safeUrl = String(hlsUrl).replace(/\r?\n/g, "");
  execSync(`ffmpeg -y -i "${safeUrl}" -frames:v 1 -q:v 2 "${outPath}"`, { stdio: "ignore" });
  if (!fs.existsSync(outPath)) throw new Error("ffmpeg nie wygenerował pliku klatki");
  console.log("✅ Frame captured:", outPath);
}

async function analyzeImage(path) {
  const image = await Jimp.read(path);
  const width = image.bitmap.width;
  const height = image.bitmap.height;

  // Bierzemy 50% szerokości (prawą połowę)
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

    // Pobranie HLS URL przez yt-dlp (z cookies)
    const hlsUrl = getHLSUrlViaYtdlp(VIDEO_ID);
    console.log("🔗 HLS URL:", hlsUrl);

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
