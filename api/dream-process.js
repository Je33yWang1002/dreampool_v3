import { IncomingForm } from 'formidable';
import fs from 'fs';
import fetch from 'node-fetch';
import FormData from 'form-data';

export const config = {
  api: { bodyParser: false }, 
};

export default async function handler(req, res) {
  // 只允許 POST 方法（傳送資料）
  if (req.method !== 'POST') {
    return res.status(405).json({ error: "請使用 POST 方法" });
  }

  const form = new IncomingForm();

  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(500).json({ error: "檔案解析失敗" });

    try {
      // 1. 檢查有沒有錄音檔
      const audioFile = Array.isArray(files.file) ? files.file[0] : files.file;
      if (!audioFile) throw new Error("沒收到錄音檔案，請檢查麥克風權限");
      
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
      if (whisperResult.error) throw new Error(`Whisper 錯誤: ${whisperResult.error.message}`);
      
      const rawText = whisperResult.text;

      // 3. 呼叫 Gemini (生成夢境指令與標籤)
      const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ 
            parts: [{ text: `你是一位專門處理夢境的超現實導演。請根據以下夢境內容，產生一個適合 Luma AI 的英文影片提示詞(videoPrompt)，並提取3個情緒標籤(tags)。請嚴格以 JSON 格式回傳。夢境內容：${rawText}` }] 
          }],
          generationConfig: { responseMimeType: "application/json" }
        })
      });

      const geminiResult = await geminiRes.json();
      
      // 檢查 Gemini 是否有正確回傳
      if (!geminiResult.candidates) throw new Error("Gemini 沒有回傳結果，請檢查 API Key");
      
      const structuredData = JSON.parse(geminiResult.candidates[0].content.parts[0].text);

      // 4. 回傳給網頁
      return res.status(200).json({
        success: true,
        rawTranscript: rawText,
        videoPrompt: structuredData.videoPrompt,
        tags: structuredData.tags || []
      });

    } catch (error) {
      // 如果出錯了，回傳錯誤訊息，這樣畫面上才不會只有 undefined
      return res.status(500).json({ 
        success: false, 
        rawTranscript: "讀取失敗", 
        videoPrompt: error.message, 
        tags: ["錯誤"] 
      });
    }
  });
}
