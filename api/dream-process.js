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

      // 讀取錄音檔並轉成 Base64 編碼（這是 Gemini 讀取二進位檔案的方式）
      const audioBase64 = fs.readFileSync(audioFile.filepath).toString('base64');

      // --- 這裡改用 Gemini 同時處理 聽力 + 導演任務 ---
      const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ 
            parts: [
              { inline_data: { mime_type: "audio/webm", data: audioBase64 } },
              { text: "你是一位精通心理學的電影導演。請先聽這段錄音內容，然後執行：1.將語音轉為繁體中文逐字稿。2.根據內容寫出一段高品質的英文影片提示詞(Video Prompt)。3.提取3個情緒標籤。請只回傳 JSON：{\"rawTranscript\": \"逐字稿內容\", \"videoPrompt\": \"英文指令\", \"tags\": [\"標籤1\", \"標籤2\"]}" }
            ] 
          }],
          generationConfig: { responseMimeType: "application/json" }
        })
      });

      const geminiData = await geminiRes.json();
      
      if (!geminiData.candidates) {
        throw new Error("Gemini 沒反應，請檢查 API Key 是否正確");
      }

      const aiResponse = JSON.parse(geminiData.candidates[0].content.parts[0].text);

      // --- 回傳給你的網頁 ---
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
