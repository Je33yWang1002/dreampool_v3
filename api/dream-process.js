import { IncomingForm } from 'formidable';
import fs from 'fs';
import fetch from 'node-fetch';
import crypto from 'crypto';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const KLING_API_KEY = process.env.KLING_API_KEY;

export const config = { api: { bodyParser: false } };

// 核心修正：Kling 專用的 JWT 生成邏輯
function generateKlingToken(apiKey) {
  if (!apiKey || !apiKey.includes('.')) {
    console.error("API Key 格式不正確，應為 AccessKey.SecretKey");
    return null;
  }

  const [accessKey, secretKey] = apiKey.split('.');
  const header = { alg: 'HS256', typ: 'JWT' };
  
  // 設定時間戳：當前時間與 30 分鐘後過期
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: accessKey,
    exp: now + 1800, // 30 minutes
    nbf: now - 60    // 提前 1 分鐘避免伺服器時間誤差
  };

  const base64Url = (str) => Buffer.from(str).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signatureInput = `${encodedHeader}.${encodedPayload}`;
  
  const signature = crypto
    .createHmac('sha256', secretKey)
    .update(signatureInput)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${signatureInput}.${signature}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: "Method not allowed" });

  const form = new IncomingForm();
  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(500).json({ error: "解析失敗" });

    try {
      const mode = Array.isArray(fields.mode) ? fields.mode[0] : fields.mode || 'transcribe';

      // --- 語音轉文字 ---
      if (mode === 'transcribe') {
        const audioFile = Array.isArray(files.file) ? files.file[0] : files.file;
        const fileStream = fs.createReadStream(audioFile.filepath);
        const FormDataNode = await import('form-data').then(m => m.default);
        const fd = new FormDataNode();
        fd.append('file', fileStream, { filename: 'dream.webm' });
        fd.append('model', 'whisper-1');

        const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, ...fd.getHeaders() },
          body: fd
        });
        const whisperResult = await whisperRes.json();
        const rawText = whisperResult.text || "";

        const chatRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: "gpt-4o",
            messages: [
              { role: "system", content: "你是一位精準的夢境分析師。請提取場景、情緒、人物、顏色、感受。回傳 JSON。" },
              { role: "user", content: `原始夢境：${rawText}` }
            ],
            response_format: { type: "json_object" }
          })
        });
        const chatData = await chatRes.json();
        return res.status(200).json({ success: true, rawTranscript: rawText, seeds: JSON.parse(chatData.choices[0].message.content).seeds });
      } 
      
      // --- Kling 影片下單 ---
      else if (mode === 'develop') {
        const seeds = JSON.parse(Array.isArray(fields.seeds) ? fields.seeds[0] : fields.seeds);
        
        const gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: "gpt-4o",
            messages: [{ role: "system", content: "編寫一段高品質英文影片指令 (Video Prompt)，超現實夢幻風格。" }, { role: "user", content: JSON.stringify(seeds) }],
            response_format: { type: "json_object" }
          })
        });
        const { prompt, tags } = JSON.parse((await gptRes.json()).choices[0].message.content);

        // 生成最新的 Token
        const token = generateKlingToken(KLING_API_KEY);
        if (!token) throw new Error("Kling Token 生成失敗，請檢查環境變數 KLING_API_KEY");

        const klingRes = await fetch('https://api.klingai.com/v1/videos/text2video', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`, // 注意：這裡必須保留 Bearer 字樣
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: "kling-v1",
            prompt: prompt,
            aspect_ratio: "9:16"
          })
        });
        const klingData = await klingRes.json();

        if (klingData.code !== 0) {
          throw new Error(`Kling API 回傳錯誤: ${klingData.message} (代碼:${klingData.code})`);
        }

        return res.status(200).json({ success: true, videoPrompt: prompt, tags, taskId: klingData.data.task_id });
      }

      // --- 查詢進度 ---
      else if (mode === 'check_status') {
        const taskId = Array.isArray(fields.taskId) ? fields.taskId[0] : fields.taskId;
        const token = generateKlingToken(KLING_API_KEY);
        
        const checkRes = await fetch(`https://api.klingai.com/v1/videos/text2video/${taskId}`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${token}` }
        });
        const checkData = await checkRes.json();
        const videoUrl = checkData.data?.task_result?.videos?.[0]?.url || "";

        return res.status(200).json({ success: true, status: checkData.data?.task_status, videoUrl });
      }

    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });
}
