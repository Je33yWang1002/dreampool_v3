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
      // 取得錄音檔
      const audioFile = Array.isArray(files.file) ? files.file[0] : files.file;
      if (!audioFile) throw new Error("沒收到錄音檔案");
      
      const fileStream = fs.createReadStream(audioFile.filepath);

      // --- 1. Whisper 語音轉文字 ---
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

      // 檢查 Whisper 是否報錯
      if (!whisperRes.ok) {
          const errorMsg = await whisperRes.text();
          throw new Error(`Whisper API 錯誤: ${errorMsg}`);
      }

      const whisperResult = await whisperRes.json();
      const rawText = whisperResult.text || "（未能辨識出語音內容）";

      // --- 2. Gemini 生成指令 ---
      const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ 
            parts: [{ text: `你是一位超現實導演。請將夢境轉為 Luma AI 影片指令。格式：{"videoPrompt": "...", "tags": ["標籤1"]}。夢境內容：${rawText}` }] 
          }],
          generationConfig: { responseMimeType: "application/json" }
        })
      });

      const geminiResult = await geminiRes.json();
      
      let structuredData = { videoPrompt: "無法生成指令", tags: ["未知"] };
      if (geminiResult.candidates && geminiResult.candidates[0].content.parts[0].text) {
          structuredData = JSON.parse(geminiResult.candidates[0].content.parts[0].text);
      }

      // --- 3. 回傳結果 ---
      return res.status(200).json({
        success: true,
        rawTranscript: rawText,
        videoPrompt: structuredData.videoPrompt,
        tags: structuredData.tags
      });

    } catch (error) {
      console.error(error);
      // 這邊把錯誤傳給前端，讓你能在網頁上直接看到訊息
      return res.status(500).json({ success: false, error: error.message });
    }
  });
}
