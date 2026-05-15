import { IncomingForm } from 'formidable';
import fs from 'fs';
import fetch from 'node-fetch';
import crypto from 'crypto'; 
import FormData from 'form-data';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const KLING_API_KEY = process.env.KLING_API_KEY ? process.env.KLING_API_KEY.trim() : '';

export const config = { api: { bodyParser: false } };

// 🔥【2026 官方規格鎖死版】精確對接 Kling 後台的雜湊簽章演算法
function getKlingAuthHeader(apiKey) {
  if (!apiKey) return '';
  try {
    let accessKeyId = '';
    let secretAccessKey = '';

    // 嚴格對接你的金鑰：sk-11c0717a842d43b4b2ed3977528f95f3
    if (apiKey.startsWith('sk-') && apiKey.length === 35) {
      // 剝除前 3 碼 'sk-'，剩下 32 碼
      const core = apiKey.substring(3); 
      // 嚴格平分前後各 16 碼
      accessKeyId = core.substring(0, 16);    // 得到 11c0717a842d43b4
      secretAccessKey = core.substring(16);   // 得到 b2ed3977528f95f3
    } else if (apiKey.includes('.')) {
      [accessKeyId, secretAccessKey] = apiKey.split('.');
    } else {
      return `Bearer ${apiKey}`;
    }

    // 1. 標準 JWT 標頭
    const header = { alg: 'HS256', typ: 'JWT' };
    
    // 2. 當前時間戳記與過期時間
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: accessKeyId.trim(),
      exp: now + 300, // 5 分鐘有效
      nbf: now - 5
    };

    // Base64Url 編碼轉換器
    const base64UrlEncode = (obj) => {
      return Buffer.from(JSON.stringify(obj))
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
    };

    const encodedHeader = base64UrlEncode(header);
    const encodedPayload = base64UrlEncode(payload);
    
    // ⚠️【關鍵修正】：Kling 官方要求的加密基底字串必須用點號相連
    const tokenData = `${encodedHeader}.${encodedPayload}`;

    // ⚠️【關鍵修正】：使用純粹的 16 位元 secretAccessKey 進行 HMAC-SHA256 簽名
    const signature = crypto
      .createHmac('sha256', secretAccessKey.trim())
      .update(tokenData)
      .digest('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

    // 組裝成 Kling 認證看門人唯一放行的 Bearer Token
    return `Bearer ${tokenData}.${signature}`;
  } catch (e) {
    console.error("Kling 簽章計算失敗:", e);
    return `Bearer ${apiKey}`;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: "Method not allowed" });

  const form = new IncomingForm();
  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(500).json({ success: false, error: "解析表單失敗" });

    try {
      const modeField = fields.mode;
      const mode = Array.isArray(modeField) ? modeField[0] : modeField || 'transcribe';

      // --- 階段一：語音轉文字 (Whisper) ---
      if (mode === 'transcribe') {
        const audioFile = Array.isArray(files.file) ? files.file[0] : files.file;
        if (!audioFile) throw new Error("找不到錄音檔案");
        
        const filePath = audioFile.filepath || audioFile.path;
        const fileStream = fs.createReadStream(filePath);
        
        const fd = new FormData();
        fd.append('file', fileStream, { filename: 'dream.webm', contentType: 'audio/webm' });
        fd.append('model', 'whisper-1');

        const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: { 
            'Authorization': `Bearer ${OPENAI_API_KEY}`, 
            ...fd.getHeaders() 
          },
          body: fd
        });
        
        if (!whisperRes.ok) {
          const errText = await whisperRes.text();
          throw new Error(`Whisper 語音辨識失敗: ${errText}`);
        }
        
        const whisperResult = await whisperRes.json();
        const rawText = whisperResult.text || "";

        if (!rawText) throw new Error("夢境聲音太小，請再說清楚一點點");

        const chatRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 
            'Authorization': `Bearer ${OPENAI_API_KEY}`, 
            'Content-Type': 'application/json' 
          },
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
          headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
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

        const klingAuthToken = getKlingAuthHeader(KLING_API_KEY);

        const klingRes = await fetch('https://api.klingai.com/v1/videos/text2video', {
          method: 'POST',
          headers: {
            'Authorization': klingAuthToken,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: "kling-v1",
            prompt: prompt,
            aspect_ratio: "9:16",
            duration: "5"
          })
        });
        const klingData = await klingRes.json();
        
        if (klingData.code && klingData.code !== 0) {
          throw new Error(`Kling 錯誤 [${klingData.code}]: ${klingData.message}`);
        }

        const taskId = klingData.data?.task_id;
        if (!taskId) {
          throw new Error(klingData.message || "Kling 未取得任務 ID");
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
        const klingAuthToken = getKlingAuthHeader(KLING_API_KEY);
        
        const checkRes = await fetch(`https://api.klingai.com/v1/videos/text2video/${taskId}`, {
          method: 'GET',
          headers: { 'Authorization': klingAuthToken }
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
