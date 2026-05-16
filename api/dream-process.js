import { IncomingForm } from 'formidable';
import crypto from 'crypto';

export const config = { api: { bodyParser: false } };

// 🔒 安全升級：改成從 Vercel 後台保險箱讀取，不要寫死在這裡
const ACCESS_KEY = process.env.KLING_ACCESS_KEY;
const SECRET_KEY = process.env.KLING_SECRET_KEY;

const BASE_URL = "https://api-singapore.klingai.com";

/**
 * 專為 Kling 海外版設計的白話文 JWT 加密公式
 */
function generateKlingToken(ak, sk) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: ak,
    exp: now + 1800, // 30 分鐘有效
    nbf: now - 5
  };

  const base64UrlEncode = (obj) => {
    return Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  };

  const tokenHeader = base64UrlEncode(header);
  const tokenPayload = base64UrlEncode(payload);

  const signature = crypto
    .createHmac('sha256', sk)
    .update(`${tokenHeader}.${tokenPayload}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${tokenHeader}.${tokenPayload}.${signature}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: '只支援 POST 請求' });
  }

  const form = new IncomingForm();
  form.parse(req, async (err, fields) => {
    if (err) {
      return res.status(500).json({ success: false, error: '解析表單失敗' });
    }

    const mode = Array.isArray(fields.mode) ? fields.mode[0] : fields.mode;

    // ---------------- 階段一：建立影片生成任務 ----------------
    if (mode === 'create_task') {
      const prompt = Array.isArray(fields.prompt) ? fields.prompt[0] : fields.prompt;
      
      if (!prompt) {
        return res.status(400).json({ success: false, error: '缺少提示詞 (prompt)' });
      }

      try {
        const token = generateKlingToken(ACCESS_KEY, SECRET_KEY);

        const apiRes = await fetch(`${BASE_URL}/v1/videos/text2video`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            model: "kling-v2.6-std", // 使用標準模型加速，也可以依需求改為 kling-v2.6-pro
            prompt: prompt,
            duration: 5,
            aspect_ratio: "9:16"
          })
        });

        const apiData = await apiRes.json();

        if (!apiRes.ok || apiData.code !== 0) {
          return res.status(500).json({ success: false, error: apiData.message || 'Kling 建立任務失敗' });
        }

        // 把 Kling 給的任務 ID 傳回前端
        return res.status(200).json({
          success: true,
          taskId: apiData.data?.task_id
        });

      } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
      }
    }

    // ---------------- 階段二：定時查詢影片到底好了沒 ----------------
    else if (mode === 'check_status') {
      const taskId = Array.isArray(fields.taskId) ? fields.taskId[0] : fields.taskId;
      if (!taskId) {
        return res.status(400).json({ success: false, error: '缺少任務 ID (taskId)' });
      }

      try {
        const token = generateKlingToken(ACCESS_KEY, SECRET_KEY);

        // 使用最新的海外專用查詢網址
        const checkRes = await fetch(`${BASE_URL}/v1/videos/text2video/${taskId}`, {
          method: 'GET',
          headers: { 
            'Authorization': `Bearer ${token}` 
          }
        });
        
        const checkData = await checkRes.json();

        if (!checkRes.ok || checkData.code !== 0) {
          return res.status(500).json({ success: false, error: checkData.message || '查詢狀態失敗' });
        }

        const taskStatus = checkData.data?.task_status; // 會是 SUCCESS / PROCESSING / FAILED
        let videoUrl = "";

        // 如果成功了，直接把真實的 mp4 影片網址抓出來
        if ((taskStatus === 'SUCCESS' || taskStatus === 'SUCCEED') && checkData.data?.task_result?.videos) {
          videoUrl = checkData.data.task_result.videos[0]?.url || "";
        }

        return res.status(200).json({
          success: true,
          status: taskStatus,
          videoUrl: videoUrl
        });

      } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
      }
    }

    else {
      return res.status(400).json({ success: false, error: '未知的操作模式' });
    }
  });
}
