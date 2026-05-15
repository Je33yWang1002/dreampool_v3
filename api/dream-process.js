import { IncomingForm } from 'formidable';
import fs from 'fs';
import fetch from 'node-fetch';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  const form = new IncomingForm();
  form.parse(req, async (err, fields, files) => {
    try {
      const audioFile = Array.isArray(files.file) ? files.file[0] : files.file;
      if (!audioFile) throw new Error("錄音檔讀取失敗");

      // 將錄音檔轉成 Gemini 看得懂的格式 (Base64)
      const audioData = fs.readFileSync(audioFile.filepath).toString('base64');

      // --- 步驟：直接傳送到 Gemini (它會聽聲音 + 生成指令) ---
      const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inlineData: { mimeType: "audio/webm", data: audioData } },
              { text: "你是一位電影導演。請先將這段音檔轉錄為中文逐字稿，然後根據內容轉換成高品質的英文影片提示詞(Video Prompt)，並提取3個情緒標籤。請嚴格只回傳 JSON 格式：{\"rawTranscript\": \"逐字稿內容\", \"videoPrompt\": \"...\", \"tags\": [\"標籤1\", \"標籤2\"]}" }
            ]
          }],
          generationConfig: { responseMimeType: "application/json" }
        })
      });

      const geminiData = await geminiRes.json();
      
      if (geminiData.error) throw new Error("Gemini 處理失敗: " + geminiData.error.message);

      const aiResponse = JSON.parse(geminiData.candidates[0].content.parts[0].text);

      // --- 回傳給前端 ---
      res.status(200).json({
        success: true,
        rawTranscript: aiResponse.rawTranscript,
        videoPrompt: aiResponse.videoPrompt,
        tags: aiResponse.tags
      });

    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
}
