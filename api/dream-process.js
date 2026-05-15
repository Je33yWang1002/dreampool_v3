import { IncomingForm } from 'formidable';
import fs from 'fs';
import fetch from 'node-fetch';
import FormData from 'form-data';

export const config = {
  api: { bodyParser: false }, 
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: "Method not allowed" });

  const form = new IncomingForm();

  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(500).json({ error: "檔案解析失敗" });

    try {
      const audioFile = Array.isArray(files.file) ? files.file[0] : files.file;
      if (!audioFile) throw new Error("沒收到錄音檔案");
      
      const fileStream = fs.createReadStream(audioFile.filepath);

      // --- 1. OpenAI Whisper (語音轉文字) ---
      const whisperData = new FormData();
      whisperData.append('file', fileStream, { filename: 'dream.webm' });
      whisperData.append('model', 'whisper-1');

      const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          ...whisperData.getHeaders() 
        },
        body: whisperData
      });

      if (!whisperRes.ok) throw new Error("Whisper 語音辨識失敗");
      const whisperResult = await whisperRes.json();
      const rawText = whisperResult.text || "（未辨識到語音）";

      // --- 2. Google Gemini (生成指令) ---
      const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ 
            parts: [{ text: `請根據這段夢境： 「${rawText}」，產出一個影片生成指令。
            注意：直接給我文字即可，不要加任何標點符號、不要加 JSON 格式、不要加程式碼外框。` }] 
          }]
        })
      });

      const geminiResult = await geminiRes.json();
      
      // 我們直接抓取 Gemini 吐出來的第一行純文字，不再強求 JSON 格式
      let finalPrompt = "無法生成指令";
      if (geminiResult.candidates && geminiResult.candidates[0].content.parts[0].text) {
          finalPrompt = geminiResult.candidates[0].content.parts[0].text.trim();
      }

      // --- 3. 回傳結果 (手動組成前端要的格式) ---
      return res.status(200).json({
        success: true,
        rawTranscript: rawText,
        videoPrompt: finalPrompt,
        tags: ["夢境分析", "自動生成"] // 暫時給固定標籤，確保畫面不報錯
      });

    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });
}
