import { IncomingForm } from 'formidable';
import fs from 'fs';
import fetch from 'node-fetch';
import FormData from 'form-data';

export const config = {
  api: { bodyParser: false }, // 告訴 Vercel 不要自動處理資料，交給我們手動解析
};

export default async function handler(req, res) {
  const form = new IncomingForm();

  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(500).json({ error: "檔案解析失敗" });

    try {
      // 1. 取得錄音檔 (修正可能讀不到檔案的問題)
      const audioFile = Array.isArray(files.file) ? files.file[0] : files.file;
      if (!audioFile) throw new Error("沒收到錄音檔案");
      
      const fileStream = fs.createReadStream(audioFile.filepath);

      // 2. 呼叫 Whisper (語音轉文字)
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

      const whisperResult = await whisperRes.json();
      const rawText = whisperResult.text;

      // 3. 呼叫 Gemini (生成夢境指令與標籤)
      const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ 
            parts: [{ text: `你是一位超現實導演。將夢境轉為 Luma AI 影片指令。格式：{"videoPrompt": "...", "tags": ["..."]}。夢境內容：${rawText}` }] 
          }],
          generationConfig: { responseMimeType: "application/json" }
        })
      });

      const geminiResult = await geminiRes.json();
      const structuredData = JSON.parse(geminiResult.candidates[0].content.parts[0].text);

      // 4. 回傳（目前先做到這裡，確認文字能出來）
      return res.status(200).json({
        success: true,
        rawTranscript: rawText,
        videoPrompt: structuredData.videoPrompt,
        tags: structuredData.tags
      });

    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });
}
