import "reflect-metadata";
jest.mock("../ContentBaseController", () => ({ ContentBaseController: class { json(obj: any, status: number) { return { obj, status }; } } }));
jest.mock("../../helpers/index", () => ({ Environment: { fileStore: "S3", jwtSecret: "test-secret" }, Permissions: { content: { edit: "contentEdit" } } }));
// apihelper ships untransformed ESM; stub the symbols GalleryController uses.
jest.mock("@churchapps/apihelper", () => ({
  __esModule: true,
  AwsHelper: { S3PresignedUrl: jest.fn(async (key: string) => ({ key, url: "https://s3.test/upload" })) },
  FileStorageHelper: { list: jest.fn(async () => ["c1/gallery/0/1.jpg"]), remove: jest.fn(async () => {}), store: jest.fn(async () => {}) }
}));

import { GalleryController } from "../GalleryController.js";
import { AwsHelper, FileStorageHelper } from "@churchapps/apihelper";
import { Environment } from "../../helpers/index.js";

function makeController(opts: any = {}) {
  const au = {
    churchId: "c1",
    groupIds: opts.groupIds ?? [],
    leaderGroupIds: opts.leaderGroupIds ?? [],
    checkAccess: (perm: string) => (opts.access ?? []).includes(perm)
  };
  const controller = new GalleryController();
  (controller as any).actionWrapper = (_req: any, _res: any, action: any) => action(au);
  (controller as any).actionWrapperAnon = (_req: any, _res: any, action: any) => action();
  (controller as any).json = (obj: any, status: number) => ({ obj, status });
  return { controller, au };
}

beforeEach(() => {
  (AwsHelper.S3PresignedUrl as jest.Mock).mockClear();
  (FileStorageHelper.list as jest.Mock).mockClear();
  (FileStorageHelper.remove as jest.Mock).mockClear();
  (FileStorageHelper.store as jest.Mock).mockClear();
  (Environment as any).fileStore = "S3";
});

describe("GalleryController.getUploadUrl", () => {
  it("issues a presigned url for a content admin", async () => {
    const { controller } = makeController({ access: ["contentEdit"] });
    const result: any = await controller.getUploadUrl({ body: { folder: "0", fileName: "1.jpg" } } as any, {} as any);
    expect(result.key).toBe("c1/gallery/0/1.jpg");
  });

  // A group leader can already create and edit their group's calendar events (EventController.save
  // allows leaderGroupIds), so the "Insert Image" button in the event description editor must work
  // for them too instead of 401ing into a misleading "API may not be available" alert.
  it("issues a presigned url for a group leader without content.edit", async () => {
    const { controller } = makeController({ leaderGroupIds: ["g1"] });
    const result: any = await controller.getUploadUrl({ body: { folder: "0", fileName: "1.jpg" } } as any, {} as any);
    expect(result.status).not.toBe(401);
    expect(result.key).toMatch(/^c1\/gallery\/0\/1-[0-9a-f]{12}\.jpg$/);
  });

  it("rejects non-image uploads from a group leader", async () => {
    const { controller } = makeController({ leaderGroupIds: ["g1"] });
    const result: any = await controller.getUploadUrl({ body: { folder: "0", fileName: "x.html" } } as any, {} as any);
    expect(result.status).toBe(400);
  });

  it("rejects a plain member who leads no groups", async () => {
    const { controller } = makeController({ groupIds: ["g1"] });
    const result: any = await controller.getUploadUrl({ body: { folder: "0", fileName: "1.jpg" } } as any, {} as any);
    expect(result.status).toBe(401);
    expect(AwsHelper.S3PresignedUrl).not.toHaveBeenCalled();
  });
});

describe("GalleryController.getAll", () => {
  it("lists gallery images for a group leader without content.edit", async () => {
    const { controller } = makeController({ leaderGroupIds: ["g1"] });
    const result: any = await controller.getAll("0", {} as any, {} as any);
    expect(result.status).not.toBe(401);
    expect(result.images).toEqual(["c1/gallery/0/1.jpg"]);
  });

  it("rejects a plain member who leads no groups", async () => {
    const { controller } = makeController({});
    const result: any = await controller.getAll("0", {} as any, {} as any);
    expect(result.status).toBe(401);
  });
});

describe("GalleryController.delete", () => {
  // Deleting from the shared church gallery stays admin-only - a leader uploading for their own
  // event should not be able to remove a website admin's images.
  it("rejects a group leader without content.edit", async () => {
    const { controller } = makeController({ leaderGroupIds: ["g1"] });
    const result: any = await controller.delete("0", "1.jpg", {} as any, {} as any);
    expect(result.status).toBe(401);
    expect(FileStorageHelper.remove).not.toHaveBeenCalled();
  });

  it("allows a content admin", async () => {
    const { controller } = makeController({ access: ["contentEdit"] });
    await controller.delete("0", "1.jpg", {} as any, {} as any);
    expect(FileStorageHelper.remove).toHaveBeenCalledWith("c1/gallery/0/1.jpg");
  });
});

// Self-hosted installs keep files on disk (FILE_STORE=disk): there is no S3 presigned POST, so requestUpload hands back
// a signed upload url on the API itself and the browser posts the same multipart form there.
describe("GalleryController disk store", () => {
  beforeEach(() => { (Environment as any).fileStore = "disk"; });

  const request = { protocol: "http", headers: {}, get: () => "api.test" };
  const requestUpload = (controller: GalleryController, body: any) => controller.getUploadUrl({ ...request, body } as any, {} as any);
  const upload = (controller: GalleryController, query: any, file?: any) => controller.upload({ query, files: file ? { file } : undefined } as any, {} as any);
  const jpeg = { mimetype: "image/jpeg", data: Buffer.from("jpeg-bytes") };

  it("returns a signed upload url on the api instead of an S3 presigned post", async () => {
    const { controller } = makeController({ access: ["contentEdit"] });
    const result: any = await requestUpload(controller, { folder: "1.78", fileName: "1700000000.jpeg", contentType: "image/jpeg" });
    expect(result.key).toBe("c1/gallery/1.78/1700000000.jpeg");
    expect(result.fields).toEqual({});
    expect(result.url).toMatch(/^http:\/\/api\.test\/content\/gallery\/upload\?key=c1%2Fgallery%2F1\.78%2F1700000000\.jpeg&token=\d+\.[0-9a-f]{64}$/);
    expect(AwsHelper.S3PresignedUrl).not.toHaveBeenCalled();
  });

  it("only accepts images, even from content editors, because disk files are served from the api origin", async () => {
    const { controller } = makeController({ access: ["contentEdit"] });
    expect((await requestUpload(controller, { folder: "0", fileName: "page.html" }) as any).status).toBe(400);
    expect((await requestUpload(controller, { folder: "0", fileName: "logo.svg", contentType: "image/svg+xml" }) as any).status).toBe(400);
  });

  it("stores the posted file under the signed key", async () => {
    const { controller } = makeController({ access: ["contentEdit"] });
    const { url } = await requestUpload(controller, { folder: "1.78", fileName: "1.jpg", contentType: "image/jpeg" }) as any;
    const query = Object.fromEntries(new URL(url).searchParams);
    expect(await upload(controller, query, jpeg)).toEqual({});
    expect(FileStorageHelper.store).toHaveBeenCalledWith("c1/gallery/1.78/1.jpg", "image/jpeg", jpeg.data);
  });

  it("rejects a tampered key, a bad signature and an expired token", async () => {
    const { controller } = makeController({ access: ["contentEdit"] });
    const { url } = await requestUpload(controller, { folder: "1.78", fileName: "1.jpg" }) as any;
    const query = Object.fromEntries(new URL(url).searchParams);
    const [exp, sig] = query.token.split(".");
    expect((await upload(controller, { ...query, key: "c2/gallery/1.78/1.jpg" }, jpeg) as any).status).toBe(401);
    expect((await upload(controller, { ...query, token: exp + "." + "0".repeat(64) }, jpeg) as any).status).toBe(401);
    const past = Math.floor(Date.now() / 1000) - 1;
    expect((await upload(controller, { ...query, token: past + "." + GalleryController.sign(query.key, past) }, jpeg) as any).status).toBe(401);
    expect((await upload(controller, { ...query, token: exp }, jpeg) as any).status).toBe(401);
    expect(sig).toHaveLength(64);
    expect(FileStorageHelper.store).not.toHaveBeenCalled();
  });

  it("rejects a missing file and a non-image file", async () => {
    const { controller } = makeController({ access: ["contentEdit"] });
    const { url } = await requestUpload(controller, { folder: "1.78", fileName: "1.jpg" }) as any;
    const query = Object.fromEntries(new URL(url).searchParams);
    expect((await upload(controller, query) as any).status).toBe(400);
    expect((await upload(controller, query, { mimetype: "text/html", data: Buffer.from("<script>") }) as any).status).toBe(400);
    expect(FileStorageHelper.store).not.toHaveBeenCalled();
  });

  it("lists disk file names as full keys", async () => {
    (FileStorageHelper.list as jest.Mock).mockResolvedValueOnce(["1.jpg", "2.png"]);
    const { controller } = makeController({ access: ["contentEdit"] });
    const result: any = await controller.getAll("1.78", {} as any, {} as any);
    expect(result.images).toEqual(["c1/gallery/1.78/1.jpg", "c1/gallery/1.78/2.png"]);
  });
});
