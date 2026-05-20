import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getMcpPublicBaseUrl } from '../../utils/image-upload-ticket.js';

export const CHATGPT_ASSET_WIDGET_URI = 'ui://wechat/chatgpt-asset-upload-v2.html';

function getChatGPTAssetWidgetHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root {
      color-scheme: light dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    body {
      margin: 0;
      padding: 16px;
      background: Canvas;
      color: CanvasText;
    }
    .layout {
      display: grid;
      gap: 14px;
      max-width: 760px;
    }
    .panel {
      border: 1px solid color-mix(in srgb, CanvasText 16%, transparent);
      border-radius: 8px;
      padding: 14px;
      background: color-mix(in srgb, Canvas 94%, CanvasText 6%);
    }
    label {
      display: grid;
      gap: 6px;
      font-size: 13px;
      margin-bottom: 10px;
    }
    input, select, button {
      font: inherit;
      box-sizing: border-box;
    }
    input, select {
      width: 100%;
      border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
      border-radius: 6px;
      padding: 8px 10px;
      background: Canvas;
      color: CanvasText;
    }
    .row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    button {
      border: 0;
      border-radius: 6px;
      padding: 9px 12px;
      background: #0f766e;
      color: white;
      cursor: pointer;
    }
    button:disabled {
      opacity: .55;
      cursor: not-allowed;
    }
    .muted {
      color: color-mix(in srgb, CanvasText 62%, transparent);
      font-size: 12px;
      line-height: 1.5;
    }
    pre {
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      border-radius: 6px;
      padding: 10px;
      background: color-mix(in srgb, CanvasText 8%, transparent);
      font-size: 12px;
      max-height: 280px;
    }
    @media (max-width: 640px) {
      .row {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <main class="layout">
    <section class="panel">
      <div class="row">
        <label>
          directoryId
          <input id="directoryId" placeholder="首次上传可留空，后续自动复用" />
        </label>
        <label>
          topicSlug
          <input id="topicSlug" placeholder="例如 ai-agent-wechat-article" />
        </label>
      </div>
      <p class="muted">同一篇文章后续重传 ZIP 或替换单图时，请复用 MCP 返回的 directoryId。</p>
    </section>

    <section class="panel">
      <label>
        上传文章素材 ZIP
        <input id="bundleFile" type="file" accept=".zip,application/zip,application/x-zip-compressed,application/octet-stream" />
      </label>
      <button id="bundleButton">处理素材包</button>
      <p class="muted">ZIP 根目录需要包含 manifest.json、article.md 或 article.html，以及 images/ 下的图片。正文图片引用必须使用 asset://image/&lt;assetId&gt;。</p>
    </section>

    <section class="panel">
      <div class="row">
        <label>
          assetId
          <input id="assetId" placeholder="例如 cover 或 process-diagram" />
        </label>
        <label>
          role
          <select id="role">
            <option value="inline">inline 正文图</option>
            <option value="cover">cover 封面图</option>
          </select>
        </label>
      </div>
      <label>
        上传单张替换图片
        <input id="imageFile" type="file" accept="image/png,image/jpeg" />
      </label>
      <button id="imageButton">上传/替换单图</button>
    </section>

    <section class="panel">
      <button id="refreshButton">查看当前工作区</button>
      <pre id="output">等待操作...</pre>
    </section>
  </main>

  <script>
    const output = document.getElementById('output');
    const directoryIdInput = document.getElementById('directoryId');
    const topicSlugInput = document.getElementById('topicSlug');
    const toolInput = window.openai?.toolInput || {};

    if (toolInput.directoryId) directoryIdInput.value = toolInput.directoryId;
    if (toolInput.topicSlug) topicSlugInput.value = toolInput.topicSlug;

    function setOutput(value) {
      output.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    }

    function normalizeFileRef(uploaded, originalFile) {
      return {
        file_id: uploaded.file_id || uploaded.fileId || uploaded.id,
        download_url: uploaded.download_url || uploaded.downloadUrl,
        file_name: uploaded.file_name || uploaded.fileName || originalFile.name,
        mime_type: uploaded.mime_type || uploaded.mimeType || originalFile.type
      };
    }

    function getBundleUploadConfig() {
      return window.openai?.toolResponseMetadata?.chatgptBundleUpload;
    }

    async function uploadBundleDirectlyToMcp(file, config) {
      if (!config?.uploadUrl) {
        throw new Error('缺少 MCP ZIP 上传地址，请重新打开上传界面');
      }

      if (!/\\.zip$/i.test(file.name)) {
        throw new Error('请选择 .zip 素材包');
      }

      if (config.maxBytes && file.size > config.maxBytes) {
        throw new Error('ZIP 文件过大，当前最大允许 ' + config.maxBytes + ' 字节');
      }

      const formData = new FormData();
      formData.append(config.formField || 'file', file, file.name);

      const response = await fetch(config.uploadUrl, {
        method: config.method || 'POST',
        body: formData
      });
      const text = await response.text();
      let payload;

      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        throw new Error('MCP ZIP 上传返回了非 JSON 响应: ' + text.slice(0, 200));
      }

      if (!response.ok || !payload.ok || !payload.bundle) {
        throw new Error(payload.error || 'MCP ZIP 上传失败');
      }

      return payload.bundle;
    }

    async function uploadBundleFile(file) {
      const directUploadConfig = getBundleUploadConfig();

      if (directUploadConfig?.uploadUrl) {
        setOutput('正在直接上传 ZIP 到 MCP...');
        return uploadBundleDirectlyToMcp(file, directUploadConfig);
      }

      throw new Error('MCP 未返回 ZIP 直传地址，请重新调用 wechat_open_asset_bundle_upload 打开上传界面');
    }

    async function uploadToChatGPT(file) {
      if (!window.openai?.uploadFile) {
        throw new Error('当前环境不支持 window.openai.uploadFile');
      }

      const uploaded = await window.openai.uploadFile(file);
      const ref = normalizeFileRef(uploaded || {}, file);

      if (!ref.download_url && ref.file_id && window.openai.getFileDownloadUrl) {
        const download = await window.openai.getFileDownloadUrl({ fileId: ref.file_id });
        ref.download_url = download.download_url || download.downloadUrl || download.url;
      }

      if (!ref.download_url) {
        throw new Error('上传成功但未获得 download_url');
      }

      return ref;
    }

    async function callTool(name, args) {
      if (!window.openai?.callTool) {
        throw new Error('当前环境不支持 window.openai.callTool');
      }

      const result = await window.openai.callTool(name, args);
      const structured = result?.structuredContent || result;

      if (structured?.directoryId) {
        directoryIdInput.value = structured.directoryId;
      }

      setOutput(structured || result);
      return result;
    }

    async function runWithButton(button, task) {
      button.disabled = true;
      try {
        await task();
      } catch (error) {
        setOutput(error instanceof Error ? error.message : String(error));
      } finally {
        button.disabled = false;
      }
    }

    document.getElementById('bundleButton').addEventListener('click', event => {
      runWithButton(event.currentTarget, async () => {
        const file = document.getElementById('bundleFile').files?.[0];
        if (!file) throw new Error('请先选择 ZIP 素材包');
        const bundle = await uploadBundleFile(file);
        setOutput('正在调用 MCP 处理素材包...');
        await callTool('wechat_process_article_bundle_from_chatgpt_file', {
          directoryId: directoryIdInput.value || undefined,
          topicSlug: topicSlugInput.value || undefined,
          bundle
        });
      });
    });

    document.getElementById('imageButton').addEventListener('click', event => {
      runWithButton(event.currentTarget, async () => {
        const file = document.getElementById('imageFile').files?.[0];
        const directoryId = directoryIdInput.value;
        const assetId = document.getElementById('assetId').value;
        const role = document.getElementById('role').value;
        if (!directoryId) throw new Error('请先填写已有 directoryId');
        if (!assetId) throw new Error('请填写 assetId');
        if (!file) throw new Error('请先选择图片');
        setOutput('正在上传图片到 ChatGPT...');
        const uploadedFile = await uploadToChatGPT(file);
        setOutput('正在调用 MCP 上传/替换单图...');
        await callTool('wechat_upload_workspace_image_from_chatgpt_file', {
          directoryId,
          assetId,
          role,
          file: uploadedFile
        });
      });
    });

    document.getElementById('refreshButton').addEventListener('click', event => {
      runWithButton(event.currentTarget, async () => {
        const directoryId = directoryIdInput.value;
        if (!directoryId) throw new Error('请先填写 directoryId');
        await callTool('wechat_get_article_workspace', { directoryId });
      });
    });
  </script>
</body>
</html>`;
}

export function registerChatGPTAssetWidgetResource(server: McpServer): void {
  const publicBaseUrl = getMcpPublicBaseUrl();
  const connectDomains = publicBaseUrl ? [publicBaseUrl] : [];

  server.registerResource(
    'wechat-chatgpt-asset-upload-widget',
    CHATGPT_ASSET_WIDGET_URI,
    {
      title: '微信公众号素材包上传',
      description: '在 ChatGPT 中上传公众号文章 ZIP 素材包或替换单张图片。',
      mimeType: 'text/html',
      _meta: {
        ui: {
          prefersBorder: true,
          csp: {
            connectDomains,
            resourceDomains: [],
          },
        },
        'openai/widgetDescription': '上传 ChatGPT 生成的微信公众号文章素材包，并把图片批量上传到微信公众号。',
        'openai/widgetPrefersBorder': true,
        'openai/widgetCSP': {
          connect_domains: connectDomains,
          resource_domains: [],
        },
      },
    },
    async () => ({
      contents: [{
        uri: CHATGPT_ASSET_WIDGET_URI,
        mimeType: 'text/html',
        text: getChatGPTAssetWidgetHtml(),
      }],
    }),
  );
}
