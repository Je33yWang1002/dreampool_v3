import { IncomingForm } from 'formidable';
import fs from 'fs';
import fetch from 'node-fetch';
import FormData from 'form-data';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  const form = new IncomingForm();
  form.parse(req, async (err, fields, files) => {
    try {
      const audioFile = Array.isArray(files.file) ? files.file[0] : files.file;
      if (!audioFile) throw new Error("錄音檔讀取失敗");

      // --- 步驟 A: 傳送到 Whisper API ---
      const whisperForm = new FormData();
      // 從暫存路徑讀取檔案並建立 Stream
      whisperForm.append('file', fs.createReadStream(audioFile.filepath), {
        filename: 'audio.webm',
        contentType: 'audio/webm',
      });
      whisperForm.append('model', 'whisper-1');

      const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          ...whisperForm.getHeaders()
        },
        body: whisperForm
      });

      const whisperData = await whisperRes.json();
      if (whisperData.error) throw new Error("Whisper 辨識失敗: " + whisperData.error.message);
      
      const rawText = whisperData.text;

      // --- 步驟 B: 傳送到 Gemini 生成 Prompt ---
      const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ 
            parts: [{ text: `你是一位電影導演。請將以下夢境文本轉換成一段高品質的英文影片提示詞(Video Prompt)，並提取3個情緒標籤。請只回傳 JSON 格式：{"videoPrompt": "...", "tags": ["標籤1", "標籤2"]}。夢境內容：${rawText}` }] 
          }],
          generationConfig: { responseMimeType: "application/json" }
        })
      });

      const geminiData = await geminiRes.json();
      const aiResponse = JSON.parse(geminiData.candidates[0].content.parts[0].text);

      // --- 步驟 C: 回傳給前端 ---
      res.status(200).json({
        success: true,
        rawTranscript: rawText,
        videoPrompt: aiResponse.videoPrompt,
        tags: aiResponse.tags
      });

    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
}
s
