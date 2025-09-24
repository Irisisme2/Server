const express = require("express");
const fs = require("fs");
const Jimp = require("jimp");
const axios = require("axios");
const puppeteer = require("puppeteer");

const app = express();
const PORT = 5000;

const VIDEO_URL = "https://www.youtube.com/watch?v=yO87jeibrUU";
const WEBHOOK_URL = "https://lukaszlis.app.n8n.cloud/webhook/66d5bc91-6925-41f4-8cc5-93ddc3271aba";

let lastSentSignal = null;

function safeUnlink(path) {
  if (fs.existsSync(path)) {
    try { fs.unlinkSync(path); } catch (e) { console.warn(e.message); }
  }
}

// Pobranie screenshotu z Puppeteer
async function captureFrame(outPath) {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  // Wczytaj cookies z pliku jeśli chcesz (opcjonalnie)
  if (fs.existsSync("cookies.json")) {
    const cookies = JSON.parse(fs.readFileSync("cookies.json", "utf8"));
    await page.setCookie(...cookies);
  }

  await page.goto(VIDEO_URL, { waitUntil: "networkidle2" });

  // Czekamy aż wideo się załaduje
  await page.waitForSelector("video");

  const video = await page.$("video");
  await video.screenshot({ path: outPath });

  await browser.close();
  console.log("✅ Frame captured:", outPath);
}

// OCR i analiza
async function analyzeImage(path) {
  const image = await Jimp.read(path);

  const width = image.bitmap.width;
  const height = image.bitmap.height;

  const crop = image.clone().crop(Math.floor(width*0.65), Math.floor(height*0.3), Math.floor(width*0.35), Math.floor(height*0.7));
  const tmpPath = `crop_${Date.now()}.png`;
  await crop.writeAsync(tmpPath);

  try {
    const imageBase64 = fs.readFileSync(tmpPath, "base64");
    const res = await axios.post(
      `https://vision.googleapis.com/v1/images:annotate?key=${process.env.GOOGLE_API_KEY}`,
      { requests: [{ image: { content: imageBase64 }, features: [{ type: "TEXT_DETECTION" }] }] }
    );

    const detections = res.data.responses?.[0]?.textAnnotations || [];
    if (!detections.length) return null;

    const text = detections.map(d => d.description).join(" ").toLowerCase();
    const signals = [];

    text.split(/\s+/).forEach((w, i, arr) => {
      if (w.includes("buy")) signals.push("Buy Sygnał");
      else if (w.includes("sell") || w.includes("short")) signals.push("Sell Sygnał");
      else if (w.includes("take") && arr[i+1] && arr[i+1].includes("profit")) signals.push("Take Profit Sygnał");
    });

    const last = signals.length ? signals[signals.length-1] : null;
    return last ? { type: last, text } : null;

  } finally {
    safeUnlink(tmpPath);
  }
}

// Analiza + wysyłka
async function runAnalysis() {
  const tmpPath = "frame.png";
  try {
    await captureFrame(tmpPath);
    const signal = await analyzeImage(tmpPath);

    if (!signal) return null;

    if (signal.type === lastSentSignal) return null;
    lastSentSignal = signal.type;

    // Wyślij do webhooka
    try { await axios.post(WEBHOOK_URL, signal); console.log("✅ Sygnał wysłany"); } 
    catch (err) { console.error(err.message); }

    return signal;

  } finally {
    safeUnlink(tmpPath);
  }
}

// Automatyczna analiza co 2 minuty
async function startAutoAnalysis() {
  setInterval(runAnalysis, 2*60*1000);
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
