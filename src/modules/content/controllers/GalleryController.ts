import { AwsHelper, FileStorageHelper } from "@churchapps/apihelper";
import express from "express";
import { controller, httpDelete, httpGet, httpPost, requestParam } from "inversify-express-utils";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { Environment, Permissions } from "../helpers/index.js";
import { ContentBaseController } from "./ContentBaseController.js";

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
const IMAGE_CONTENT_TYPE = /^image\/(jpeg|png|webp|gif)$/i;
const DISK_UPLOAD_TTL_SEC = 600;
// churchId/gallery/folder/file.ext with an image extension; nothing that could climb out of the folder.
const DISK_KEY = /^[A-Za-z0-9_-]+\/gallery\/[A-Za-z0-9._-]+\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.(jpe?g|png|webp|gif)$/i;

@controller("/content/gallery")
export class GalleryController extends ContentBaseController {
  // Group leaders can create and edit their group's calendar events (see EventController.save), and
  // the description editor's "Insert Image" button posts here, so they need the gallery too.
  // Deleting from the shared church gallery stays admin-only.
  private canUseGallery(au: any) {
    return au.checkAccess(Permissions.content.edit) || au.leaderGroupIds?.length > 0;
  }

  @httpGet("/stock/:folder")
  public async getStock(@requestParam("folder") folder: string, req: express.Request<{}, {}, null>, res: express.Response): Promise<any> {
    return this.actionWrapperAnon(req, res, async () => {
      const prefix = "stockPhotos/" + path.basename(folder);
      return { images: GalleryController.toKeys(prefix, await FileStorageHelper.list(prefix)) };
    });
  }

  @httpGet("/:folder")
  public async getAll(@requestParam("folder") folder: string, req: express.Request<{}, {}, null>, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!this.canUseGallery(au)) return this.json({}, 401);
      else {
        const prefix = au.churchId + "/gallery/" + path.basename(folder);
        return { images: GalleryController.toKeys(prefix, await FileStorageHelper.list(prefix)) };
      }
    });
  }

  @httpPost("/requestUpload")
  public async getUploadUrl(req: express.Request<{}, {}, { folder: string; fileName: string; contentType?: string; size?: number }>, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!this.canUseGallery(au)) return this.json({}, 401);
      else {
        const onDisk = Environment.fileStore !== "S3";
        const isEditor = au.checkAccess(Permissions.content.edit);
        let fileName = path.basename(req.body.fileName);
        const ext = path.extname(fileName).toLowerCase();
        // Non-editors are limited to images, and so is everyone on disk, where uploads are served from the API's own origin.
        if (!isEditor || onDisk) {
          if (!IMAGE_EXTENSIONS.includes(ext)) return this.json({ error: "Unsupported image type" }, 400);
          if (req.body.contentType && !IMAGE_CONTENT_TYPE.test(req.body.contentType)) return this.json({ error: "Unsupported image type" }, 400);
        }
        // non-editors get an unguessable key so they can't overwrite existing gallery images
        if (!isEditor) fileName = path.basename(fileName, path.extname(fileName)) + "-" + crypto.randomBytes(6).toString("hex") + ext;
        if (onDisk) fileName = fileName.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "");
        const key = au.churchId + "/gallery/" + path.basename(req.body.folder) + "/" + fileName;
        if (!onDisk) return await AwsHelper.S3PresignedUrl(key, req.body.contentType, req.body.size);
        if (!DISK_KEY.test(key)) return this.json({ error: "Unsupported file name" }, 400);
        const exp = Math.floor(Date.now() / 1000) + DISK_UPLOAD_TTL_SEC;
        const url = GalleryController.apiBase(req) + "/content/gallery/upload?key=" + encodeURIComponent(key) + "&token=" + exp + "." + GalleryController.sign(key, exp);
        return { key, url, fields: {} };
      }
    });
  }

  // Disk-store counterpart of the S3 presigned POST: the same multipart form, so both Gallery copies upload unchanged.
  // The browser sends no JWT here; the token from requestUpload is the only authorisation and covers one key for 10 minutes.
  @httpPost("/upload")
  public async upload(req: express.Request, res: express.Response): Promise<any> {
    return this.actionWrapperAnon(req, res, async () => {
      if (Environment.fileStore === "S3") return this.json({}, 404);
      const key = String(req.query.key || "");
      const [exp, sig] = String(req.query.token || "").split(".");
      if (!DISK_KEY.test(key) || !GalleryController.verify(key, Number(exp), sig || "")) return this.json({}, 401);
      const file: any = (req as any).files?.file;
      if (!file) return this.json({ errors: ["file is required"] }, 400);
      if (!IMAGE_CONTENT_TYPE.test(file.mimetype || "")) return this.json({ error: "Unsupported image type" }, 400);
      const buffer: Buffer = file.data?.length ? file.data : fs.readFileSync(file.tempFilePath);
      await FileStorageHelper.store(key, file.mimetype, buffer);
      return {};
    });
  }

  @httpDelete("/:folder/:image")
  public async delete(@requestParam("folder") folder: string, @requestParam("image") image: string, req: express.Request<{}, {}, null>, res: express.Response): Promise<any> {
    return this.actionWrapper(req, res, async (au) => {
      if (!au.checkAccess(Permissions.content.edit)) return this.json({}, 401);
      else {
        await FileStorageHelper.remove(au.churchId + "/gallery/" + path.basename(folder) + "/" + path.basename(image));
        return this.json({});
      }
    });
  }

  // S3 lists full keys; the disk store lists bare file names. The Gallery builds image URLs from full keys.
  static toKeys(prefix: string, files: string[]) {
    return (files || []).map((f) => (f.includes("/") ? f : prefix + "/" + f));
  }

  static sign(key: string, exp: number) {
    return crypto.createHmac("sha256", Environment.jwtSecret || "").update(`gallery:${key}:${exp}`).digest("hex");
  }

  static verify(key: string, exp: number, sig: string) {
    if (!Environment.jwtSecret || !Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
    const a = Buffer.from(GalleryController.sign(key, exp));
    const b = Buffer.from(sig);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  private static apiBase(req: express.Request) {
    const xfProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const xfHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
    return `${xfProto || req.protocol || "https"}://${xfHost || req.get?.("host") || ""}`;
  }
}
