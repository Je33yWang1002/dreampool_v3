import { IncomingForm } from 'formidable';
import fs from 'fs';
import fetch from 'node-fetch';
import crypto from 'crypto';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const KLING_API_KEY = process.env.KLING_API_KEY;

export const config = { api: { bodyParser: false } };

// Kling JWT 生成邏輯 (修復 1000 錯誤)
function generateKlingToken(apiKey) {
  if (!apiKey || !apiKey.includes('.')) return null;
  const [accessKey, secretKey] = apiKey.split('.');
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: accessKey, exp: now + 1800, nbf: now - 60 };
  const base64Url = (str) => Buffer.from(str).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const signatureInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = crypto.createHmac('sha256', secretKey).update(signatureInput).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${signatureInput}.${signature}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: "Method not allowed" });
  const form = new IncomingForm();
  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(500).json({ error: "解析失敗" });
    try {
      const mode = Array.isArray(fields.mode) ? fields.mode[0] : fields.mode || 'transcribe';

      // --- 模式一：語音轉文字 + 提取種子 ---
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
              { role: "system", content: "你是一位精準的夢境分析師。請提取場景(scene)、情緒(mood)、人物(character)、顏色(color)、感受(feeling)。回傳 JSON。" },
              { role: "user", content: `原始夢境：${rawText}。請回傳 JSON 格式：{"seeds": {"scene": "", "mood": "", "character": "", "color": "", "feeling": ""}}` }
            ],
            response_format: { type: "json_object" }
          })
        });
        const chatData = await chatRes.json();
        const aiResponse = JSON.parse(chatData.choices[0].message.content);
        
        // 重要：這裡回傳 data.seeds，前端 index.html 才能讀到
        return res.status(200).json({ 
          success: true, 
          rawTranscript: rawText, 
          seeds: aiResponse.seeds 
        });
      } 
      
      // --- 模式二：Kling 影片生成 ---
      else if (mode === 'develop') {
        const seeds = JSON.parse(Array.isArray(fields.seeds) ? fields.seeds[0] : fields.seeds);
        const gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: "gpt-4o",
            messages: [
              { role: "system", content: "編寫一段高品質英文影片指令 (Video Prompt)，風格超現實夢幻。" },
              { role: "user", content: `種子：${JSON.stringify(seeds)}。請回傳 JSON：{"prompt": "...", "tags": ["", "", ""]}` }
            ],
            response_format: { type: "json_object" }
          })
        });
        const gptContent = JSON.parse((await gptRes.json()).choices[0].message.content);
        const token = generateKlingToken(KLING_API_KEY);

        const klingRes = await fetch('https://api.klingai.com/v1/videos/text2video', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: "kling-v1", prompt: gptContent.prompt, aspect_ratio: "9:16" })
        });
        const klingData = await klingRes.json();
        if (klingData.code !== 0) throw new Error(klingData.message);

        return res.status(200).json({ 
          success: true, 
          videoPrompt: gptContent.prompt, 
          tags: gptContent.tags, 
          taskId: klingData.data.task_id 
        });
      }

      // --- 模式三：進度查詢 ---
      else if (mode === 'check_status') {
        const taskId = Array.isArray(fields.taskId) ? fields.taskId[0] : fields.taskId;
        const token = generateKlingToken(KLING_API_KEY);
        const checkRes = await fetch(`https://api.klingai.com/v1/videos/text2video/${taskId}`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${token}` }
        });
        const checkData = await checkRes.json();
        return res.status(200).json({ 
          success: true, 
          status: checkData.data?.task_status, 
          videoUrl: checkData.data?.task_result?.videos?.[0]?.url || "" 
        });
      }
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });
}
