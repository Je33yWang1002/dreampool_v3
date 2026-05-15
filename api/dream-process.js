import { IncomingForm } from 'formidable';
import fs from 'fs';
import fetch from 'node-fetch';
import crypto from 'crypto';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const KLING_API_KEY = process.env.KLING_API_KEY;

export const config = { api: { bodyParser: false } };

// 修正後的 Kling 計算函式：完美支援 AccessKey.SecretKey 拼接格式
function getKlingAuthHeader(apiKey) {
  if (!apiKey) return '';
  try {
    let cleanKey = apiKey.trim().replace(/[\r\n]/g, '');
    
    // 如果使用者在 Vercel 後台直接填了 "AccessKey: XXX \n SecretKey: YYY" 的格式，進行相容清洗
    if (cleanKey.includes('Access Key:') || cleanKey.includes('Secret Key:')) {
      const accessMatch = cleanKey.match(/Access\s*Key:\s*([^\s]+)/i);
      const secretMatch = cleanKey.match(/Secret\s*Key:\s*([^\s]+)/i);
      if (accessMatch && secretMatch) {
        cleanKey = `${accessMatch[1].trim()}.${secretMatch[1].trim()}`;
      }
    }

    if (!cleanKey.includes('.')) {
      return cleanKey.startsWith('Bearer ') ? cleanKey : `Bearer ${cleanKey}`;
    }

    const parts = cleanKey.split('.');
    const accessKeyId = parts[0].trim();
    const secretAccessKey = parts[1].trim();

    const header = { alg: 'HS256', typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: accessKeyId,
      exp: now + 1800, 
      nbf: now - 5
    };

    const base64UrlEncode = (obj) => {
      return Buffer.from(JSON.stringify(obj))
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
    };

    const encodedHeader = base64UrlEncode(header);
    const encodedPayload = base64UrlEncode(payload);
    const tokenData = `${encodedHeader}.${encodedPayload}`;

    const signature = crypto
      .createHmac('sha256', secretAccessKey)
      .update(tokenData)
      .digest('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

    return `Bearer ${tokenData}.${signature}`;
  } catch (e) {
    console.error("Kling 驗證計算失敗：", e);
    return '';
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: "Method not allowed" });

  const form = new IncomingForm();
  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(500).json({ error: "解析失敗" });

    try {
      const modeField = fields.mode;
      const mode = Array.isArray(modeField) ? modeField[0] : modeField || 'transcribe';

      // --- 階段一：語音轉文字 ---
      if (mode === 'transcribe') {
        const audioFile = Array.isArray(files.file) ? files.file[0] : files.file;
        if (!audioFile) throw new Error("找不到錄音檔案");
        
        const filePath = audioFile.filepath || audioFile.path;
        const fileStream = fs.createReadStream(filePath);
        
        const FormDataNode = await import('form-data').then(m => m.default);
        const fd = new FormDataNode();
        fd.append('file', fileStream, { filename: 'dream.webm' });
        fd.append('model', 'whisper-1');

        const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${OPENAI_API_KEY ? OPENAI_API_KEY.trim() : ''}`, ...fd.getHeaders() },
          body: fd
        });
        const whisperResult = await whisperRes.json();
        const rawText = whisperResult.text || "";

        if (!rawText) throw new Error("語音識別失敗，請再說大聲一點");

        const chatRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${OPENAI_API_KEY ? OPENAI_API_KEY.trim() : ''}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: "gpt-4o",
            messages: [
              { role: "system", content: "你是一位精準的夢境分析師。請提取場景、情緒、人物、顏色、感受。回傳 JSON。" },
              { role: "user", content: `原始夢境：${rawText}。請回傳 JSON：{"seeds": {"scene": "", "mood": "", "character": "", "color": "", "feeling": ""}}` }
            ],
            response_format: { type: "json_object" }
          })
        });
        const chatData = await chatRes.json();
        const aiContent = JSON.parse(chatData.choices[0].message.content);
        return res.status(200).json({ success: true, rawTranscript: rawText, seeds: aiContent.seeds });
      } 
      
      // --- 階段二：Kling AI 影片下單 ---
      else if (mode === 'develop') {
        const seedsRaw = Array.isArray(fields.seeds) ? fields.seeds[0] : fields.seeds;
        const seeds = typeof seedsRaw === 'string' ? JSON.parse(seedsRaw) : seedsRaw;
        
        const gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${OPENAI_API_KEY ? OPENAI_API_KEY.trim() : ''}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: "gpt-4o",
            messages: [
              { role: "system", content: "你是一位電影編導。根據種子編寫一段高品質英文影片指令 (Video Prompt)，風格要超現實、夢幻、有藝術感。請盡量具體描述畫面和光影。" },
              { role: "user", content: `種子：${JSON.stringify(seeds)}。請回傳 JSON：{"prompt": "...", "tags": ["", "", ""]}` }
            ],
            response_format: { type: "json_object" }
          })
        });
        const gptData = await gptRes.json();
        const { prompt, tags } = JSON.parse(gptData.choices[0].message.content);

        const klingAuth = getKlingAuthHeader(KLING_API_KEY);

        const klingRes = await fetch('https://api.klingai.com/v1/videos/text2video', {
          method: 'POST',
          headers: {
            'Authorization': klingAuth,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: "kling-v1",
            prompt: prompt,
            arguments: {
              aspect_ratio: "9:16",
              duration: "5"
            }
          })
        });
        const klingData = await klingRes.json();
        
        if (klingData.code && klingData.code !== 0) {
          // 優化錯誤提示，讓前端能直接看懂點數不足的問題
          let errorMsg = klingData.message;
          if (klingData.code === 1102) {
            errorMsg = "Kling 帳戶餘額不足(1102)，請至 Kling 官網儲值點數！";
          }
          throw new Error(`Kling 錯誤 [${klingData.code}]: ${errorMsg}`);
        }

        const taskId = klingData.data?.task_id;
        if (!taskId) {
          throw new Error(klingData.message || "Kling AI 連線異常，未取得任務 ID");
        }

        return res.status(200).json({ 
          success: true, 
          videoPrompt: prompt, 
          tags: tags,
          taskId: taskId
        });
      }

      // --- 階段三：查詢進度 ---
      else if (mode === 'check_status') {
        const taskId = Array.isArray(fields.taskId) ? fields.taskId[0] : fields.taskId;
        const klingAuth = getKlingAuthHeader(KLING_API_KEY);
        
        const checkRes = await fetch(`https://api.klingai.com/v1/videos/text2video/${taskId}`, {
          method: 'GET',
          headers: { 'Authorization': klingAuth }
        });
        const checkData = await checkRes.json();
        
        const status = checkData.data?.task_status;
        
        let videoUrl = "";
        if (checkData.data?.task_result?.videos && checkData.data.task_result.videos.length > 0) {
          videoUrl = checkData.data.task_result.videos[0].url || "";
        }

        return res.status(200).json({
          success: true,
          status: status, 
          videoUrl: videoUrl
        });
      }

    } catch (error) {
      console.error(error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });
}
