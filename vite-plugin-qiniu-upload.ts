import type { Plugin, ResolvedConfig } from "vite";
import qiniu from "qiniu";
import * as crypto from "crypto";
import * as path from "path";
import * as fs from "fs/promises";
import * as fsSync from "fs";

interface QiniuPluginOptions {
  accessKey: string;
  secretKey: string;
  bucket: string;
  cdnDomain: string;
  include?: string[];
}

function md5Buffer(buffer: Buffer): string {
  const hash = crypto.createHash("md5");
  hash.update(buffer);
  return hash.digest("hex");
}

const makeAssetRegex = (exts: string[]) => {
  const extsPattern = exts.map(e => e.replace(/^\./, '')).join('|');
  // 匹配非贪婪，直到扩展名
  return new RegExp(`(?:(?:\\.\\./|\\.\\/|\\/)?assets\\/[A-Za-z0-9_\\-\\.\\/]+?\\.(?:${extsPattern}))`, 'g');
};

const makeEscapedAssetRegex = (exts: string[]) => {
  const extsPattern = exts.map(e => e.replace(/^\./, '')).join('|');
  return new RegExp(`(?:\\\\\\/assets\\\\\\/[A-Za-z0-9_\\-\\\\\\.\\\\\\/]+?\\\\\\.(?:${extsPattern}))`, 'g');
};

export default function qiniuUploadPlugin(options: QiniuPluginOptions): Plugin {
  const {
    accessKey,
    secretKey,
    bucket,
    cdnDomain,
    include = [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"],
  } = options;

  const mac = new qiniu.auth.digest.Mac(accessKey, secretKey);
  const config = new qiniu.conf.Config();
  const bucketManager = new qiniu.rs.BucketManager(mac, config);

  // 存放 fileName -> cdnUrl 映射（fileName 形如 "assets/b-xxxx.png"）
  const uploadedMap = new Map<string, string>();
  // 避免重复上传同一个 remoteKey（按 hash 命名）
  const uploadedRemoteKeys = new Set<string>();

  let outDir = "dist"; // 默认
  let resolvedConfig: ResolvedConfig | null = null;

  // 上传 buffer 到七牛
  async function uploadToQiniu(remoteKey: string, buffer: Buffer) {
    const putPolicy = new qiniu.rs.PutPolicy({ scope: `${bucket}:${remoteKey}` });
    const uploadToken = putPolicy.uploadToken(mac);
    const formUploader = new qiniu.form_up.FormUploader(config);
    const putExtra = new qiniu.form_up.PutExtra();

    return new Promise<void>((resolve, reject) => {
      formUploader.put(uploadToken, remoteKey, buffer, putExtra, (err: any, body: any, info: any) => {
        if (err) return reject(err);
        if (info && info.statusCode === 200) resolve();
        else reject(new Error("上传失败: " + JSON.stringify(body)));
      });
    });
  }

  const exts = include;
  const assetRegex = makeAssetRegex(exts);
  const escapedAssetRegex = makeEscapedAssetRegex(exts);

  // 把文本里所有可能的 /assets/... 等替换为 CDN 地址
  function replaceAssetPathsInText(text: string): string {
    if (!text) return text;

    // 先替换未转义形式
    text = text.replace(assetRegex, (match) => {
      // 将 ./ 或 / 前缀移除，得到 bundle 中的 key（bundle 中的 key 通常是 "assets/xxx.png"）
      const key = match.replace(/^(\.\/|\/)/, "");
      const cdn = uploadedMap.get(key);
      return cdn ? cdn : match;
    });

    // 再替换转义形式 (\/assets\/...)
    text = text.replace(escapedAssetRegex, (match) => {
      // 把 '\/assets\/a.png' -> '/assets/a.png'
      const unescaped = match.replace(/\\\//g, '/');
      const key = unescaped.replace(/^(\.\/|\/)/, "");
      const cdn = uploadedMap.get(key);
      if (!cdn) return match;
      // 把 cdn 转回转义形式以和原字符串一致
      return cdn.replace(/\//g, '\\/');
    });

    return text;
  }

  return {
    name: "vite-plugin-qiniu-upload",
    enforce: "post",

    configResolved(cfg) {
      resolvedConfig = cfg;
      outDir = (cfg.build && cfg.build.outDir) ? cfg.build.outDir : outDir;
    },

    async generateBundle(_, bundle) {
      // 1) 先遍历 bundle 的 asset，找到图片资源并上传，构建 uploadedMap
      for (const [fileName, asset] of Object.entries(bundle)) {
        const ext = path.extname(fileName).toLowerCase();
        if (!exts.includes(ext)) continue;
        if (asset.type !== "asset") continue;

        // 将 source 转成 Buffer
        let buffer: Buffer;
        if (typeof asset.source === "string") {
          buffer = Buffer.from(asset.source);
        } else {
          buffer = Buffer.from(asset.source as Uint8Array);
        }

        const hash = md5Buffer(buffer);
        const remoteKey = `${hash}${ext}`;
        const cdnUrl = `${cdnDomain.replace(/\/$/, "")}/${remoteKey}`;

        // 上传去重（同一 remoteKey 只上传一次）
        if (!uploadedRemoteKeys.has(remoteKey)) {
          try {
            // 先检查远端是否存在（避免重复上传）
            const exists = await new Promise<boolean>((resolve) => {
              bucketManager.stat(bucket, remoteKey, (err: any, _respBody: any, respInfo: any) => {
                if (err) return resolve(false);
                resolve(respInfo && respInfo.statusCode === 200);
              });
            });

            if (!exists) {
              // 上传
              this.warn(`上传 ${fileName} -> ${remoteKey}`);
              await uploadToQiniu(remoteKey, buffer);
            } else {
              this.warn(`远端已存在 ${remoteKey}，跳过上传`);
            }

            uploadedRemoteKeys.add(remoteKey);
          } catch (e: any) {
            this.error(`上传失败 ${fileName}: ${e?.message || e}`);
            // 不中断构建，继续处理
          }
        }

        // 记录 fileName -> cdnUrl 映射，fileName 例如 "assets/b-CvGx7FPG.png"
        uploadedMap.set(fileName, cdnUrl);
      }

      // 2) 在 bundle 内替换 JS/CSS/chunk/asset 中引用到 /assets/... 的位置
      for (const [name, output] of Object.entries(bundle)) {
        // chunk（JS）
        if (output.type === "chunk") {
          output.code = replaceAssetPathsInText(output.code);
        } else if (output.type === "asset") {
          // 可能是 CSS 或 SVG 文本
          if (typeof output.source === "string") {
            output.source = replaceAssetPathsInText(output.source);
          }
        }
      }

      // 3) 从 bundle 删除图片 asset，防止写入 dist
      for (const fileName of Array.from(uploadedMap.keys())) {
        if (bundle[fileName]) {
          delete bundle[fileName];
        }
      }
    },

    // writeBundle 在文件写入到磁盘之后触发，可以在这里进一步替换 dist 下的 index.html 等文件（因为 transformIndexHtml 的时机早于 generateBundle）
    async writeBundle() {
      try {
        const out = path.resolve(process.cwd(), outDir);
        const indexPath = path.join(out, "index.html");
        if (fsSync.existsSync(indexPath)) {
          let html = await fs.readFile(indexPath, { encoding: "utf-8" });
          const newHtml = replaceAssetPathsInText(html);
          if (newHtml !== html) {
            await fs.writeFile(indexPath, newHtml, { encoding: "utf-8" });
            this.warn(`已替换 ${indexPath} 中的资源引用为 CDN`);
          }
        } else {
          this.warn(`未找到 ${indexPath}，跳过 HTML 替换`);
        }

        // 可选：替换 dist 里所有 .html 文件（如果有多页面）
        // const files = await fs.readdir(out);
        // for (const f of files) {
        //   if (f.endsWith('.html')) {
        //     const p = path.join(out, f);
        //     let content = await fs.readFile(p, 'utf-8');
        //     const replaced = replaceAssetPathsInText(content);
        //     if (replaced !== content) await fs.writeFile(p, replaced, 'utf-8');
        //   }
        // }
      } catch (e: any) {
        this.error(`writeBundle 处理失败：${e?.message || e}`);
      }
    },
  };
}
