import { upgradeWebSocket, type WebSocketData } from "@vercel/functions";
import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import {
  ObjectStore,
  RefStore,
  LfsStore,
  PushHandler,
  FetchHandler,
} from "@ws-git/server";
import { S3ObjectStore } from "../../../lib/s3-object-store";
import { S3RefStore } from "../../../lib/s3-ref-store";
import { S3LfsStore } from "../../../lib/s3-lfs-store";

const useS3 = !!process.env.WSGIT_S3_BUCKET;
const STORE_ROOT = process.env.WSGIT_STORE ?? "/tmp/wsgit-store";
const S3_BUCKET = process.env.WSGIT_S3_BUCKET ?? "";

const s3 = useS3 ? new S3Client({}) : null;

// Per-repo stores, lazily created
const objectStores = new Map<string, any>();
const refStores = new Map<string, any>();
const lfsStores = new Map<string, any>();

function getObjects(repo: string) {
  let store = objectStores.get(repo);
  if (!store) {
    store = useS3
      ? new S3ObjectStore(s3!, S3_BUCKET, repo)
      : new ObjectStore(path.join(STORE_ROOT, repo, "objects"));
    objectStores.set(repo, store);
  }
  return store;
}

function getRefs(repo: string) {
  let store = refStores.get(repo);
  if (!store) {
    store = useS3
      ? new S3RefStore(s3!, S3_BUCKET, repo)
      : new RefStore(path.join(STORE_ROOT, repo, "refs.db"));
    refStores.set(repo, store);
  }
  return store;
}

function getLfs(repo: string) {
  let store = lfsStores.get(repo);
  if (!store) {
    store = useS3
      ? new S3LfsStore(s3!, S3_BUCKET, repo)
      : new LfsStore(path.join(STORE_ROOT, repo, "lfs"));
    lfsStores.set(repo, store);
  }
  return store;
}

function parseRoute(params: string[]): { repo: string; endpoint: string } | null {
  // params: ["owner", "repo", "push"|"fetch"|"info"|"lfs", ...]
  if (params.length < 3) return null;
  const repo = `${params[0]}/${params[1]}`;
  const endpoint = params.slice(2).join("/");
  return { repo, endpoint };
}

// --- WebSocket endpoints (push/fetch) ---

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path: segments } = await params;
  const route = parseRoute(segments);
  if (!route) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { repo, endpoint } = route;

  // LFS download: GET /repos/:owner/:repo/lfs/objects/:oid
  const lfsMatch = endpoint.match(/^lfs\/objects\/([0-9a-f]{64})$/);
  if (lfsMatch) {
    return handleLfsDownload(repo, lfsMatch[1]);
  }

  if (endpoint !== "push" && endpoint !== "fetch") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const ws = upgradeWebSocket();

  if (endpoint === "push") {
    const handler = new PushHandler(ws as any, getObjects(repo), getRefs(repo));
    let objectCount = 0;
    const startTime = Date.now();

    handler.onResult = (ref, status, message) => {
      console.log(`[${repo}] push ${ref} ${status}${message ? ": " + message : ""}`);
    };

    ws.on("message", (data: WebSocketData) => {
      const buf = Buffer.from(data as ArrayBuffer);
      // Binary frames: first byte 1-5 = object, otherwise JSON
      if (buf.length > 21 && buf[0] >= 1 && buf[0] <= 5) {
        objectCount++;
        handler.handleObject(buf);
      } else {
        const msg = JSON.parse(buf.toString());
        if (msg.skip) {
          handler.handleSkip(msg.skip);
        } else {
          console.log(`[${repo}] push ${msg.ref} → ${msg.new?.slice(0, 8)}`);
          handler.handleControl(msg);
        }
      }
    });

    ws.on("close", () => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[${repo}] push disconnected — ${objectCount} objects in ${elapsed}s`);
    });
  } else {
    const handler = new FetchHandler(ws as any, getObjects(repo), getRefs(repo));

    ws.on("message", (data: WebSocketData) => {
      const buf = Buffer.from(data as ArrayBuffer);
      // Want frames are pure binary (multiples of 20 bytes, first byte not 1-5)
      if (buf.length > 0 && buf.length % 20 === 0 && (buf[0] < 1 || buf[0] > 5)) {
        handler.handleWant(buf);
      } else {
        try {
          const msg = JSON.parse(buf.toString());
          if (msg.status === "done") {
            ws.close();
          } else {
            console.log(`[${repo}] fetch refs ${msg.ref}`);
            handler.handleControl(msg);
          }
        } catch {
          // Binary want frame that didn't match heuristic
          handler.handleWant(buf);
        }
      }
    });
  }
}

// --- HTTP endpoints (LFS) ---

export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path: segments } = await params;
  const route = parseRoute(segments);
  if (!route) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { repo, endpoint } = route;

  // LFS batch: POST /repos/:owner/:repo/info/lfs/objects/batch
  if (endpoint === "info/lfs/objects/batch") {
    const body = await req.json();
    return handleLfsBatch(req, repo, body);
  }

  return NextResponse.json({ error: "not found" }, { status: 404 });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path: segments } = await params;
  const route = parseRoute(segments);
  if (!route) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { repo, endpoint } = route;

  // LFS upload: PUT /repos/:owner/:repo/lfs/objects/:oid
  const lfsMatch = endpoint.match(/^lfs\/objects\/([0-9a-f]{64})$/);
  if (lfsMatch) {
    return handleLfsUpload(req, repo, lfsMatch[1]);
  }

  return NextResponse.json({ error: "not found" }, { status: 404 });
}

// --- LFS handlers ---

async function handleLfsBatch(req: NextRequest, repo: string, body: any) {
  const lfs = getLfs(repo);
  const { operation, objects: requested } = body;

  console.log(`[lfs] ${repo} batch ${operation} — ${requested.length} objects`);

  const responseObjects = await Promise.all(
    requested.map(async (obj: { oid: string; size: number }) => {
      const exists = await lfs.has(obj.oid);

      if (operation === "upload") {
        if (exists) return { oid: obj.oid, size: obj.size };
        // S3: pre-signed URL for direct upload. FS: proxy through function.
        const href = useS3 && "getUploadUrl" in lfs
          ? await lfs.getUploadUrl(obj.oid)
          : `${req.headers.get("x-forwarded-proto") ?? "http"}://${req.headers.get("host")}/api/repos/${repo}/lfs/objects/${obj.oid}`;
        return {
          oid: obj.oid,
          size: obj.size,
          authenticated: true,
          actions: { upload: { href } },
        };
      } else {
        if (!exists) {
          return { oid: obj.oid, size: obj.size, error: { code: 404, message: "Not found" } };
        }
        const href = useS3 && "getDownloadUrl" in lfs
          ? await lfs.getDownloadUrl(obj.oid)
          : `${req.headers.get("x-forwarded-proto") ?? "http"}://${req.headers.get("host")}/api/repos/${repo}/lfs/objects/${obj.oid}`;
        return {
          oid: obj.oid,
          size: obj.size,
          authenticated: true,
          actions: { download: { href } },
        };
      }
    }),
  );

  return NextResponse.json(
    { transfer: "basic", objects: responseObjects, hash_algo: "sha256" },
    { headers: { "Content-Type": "application/vnd.git-lfs+json" } },
  );
}

async function handleLfsUpload(req: NextRequest, repo: string, oid: string) {
  const lfs = getLfs(repo);
  const data = Buffer.from(await req.arrayBuffer());
  await lfs.put(oid, data);
  console.log(`[lfs] ${repo} upload ${oid.slice(0, 12)}`);
  return new NextResponse(null, { status: 200 });
}

async function handleLfsDownload(repo: string, oid: string) {
  const lfs = getLfs(repo);
  const size = await lfs.size(oid);
  if (size === null) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  console.log(`[lfs] ${repo} download ${oid.slice(0, 12)}`);
  // Read the file and return it
  const stream = lfs.createReadStream(oid);
  return new NextResponse(stream as any, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(size),
    },
  });
}
