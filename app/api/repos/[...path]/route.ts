import { upgradeWebSocket, type WebSocketData } from "@vercel/functions";
import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import {
  ObjectStore,
  RefStore,
  LfsStore,
  PushHandler,
  FetchHandler,
} from "@ws-git/server";
import { BlobObjectStore } from "../../../lib/blob-object-store";
import { BlobRefStore } from "../../../lib/blob-ref-store";
import { BlobLfsStore } from "../../../lib/blob-lfs-store";

const useBlob = !!process.env.BLOB_READ_WRITE_TOKEN;
const STORE_ROOT = process.env.WSGIT_STORE ?? "/tmp/wsgit-store";
console.log(`[wsgit] storage backend: ${useBlob ? "Vercel Blob" : "filesystem"}`);

// Per-repo stores, lazily created
const objectStores = new Map<string, any>();
const refStores = new Map<string, any>();
const lfsStores = new Map<string, any>();

function getObjects(repo: string) {
  let store = objectStores.get(repo);
  if (!store) {
    store = useBlob
      ? new BlobObjectStore(repo)
      : new ObjectStore(path.join(STORE_ROOT, repo, "objects"));
    objectStores.set(repo, store);
  }
  return store;
}

function getRefs(repo: string) {
  let store = refStores.get(repo);
  if (!store) {
    store = useBlob
      ? new BlobRefStore(repo)
      : new RefStore(path.join(STORE_ROOT, repo, "refs.db"));
    refStores.set(repo, store);
  }
  return store;
}

function getLfs(repo: string) {
  let store = lfsStores.get(repo);
  if (!store) {
    store = useBlob
      ? new BlobLfsStore(repo)
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

      const baseUrl = `${req.headers.get("x-forwarded-proto") ?? "http"}://${req.headers.get("host")}/api/repos/${repo}/lfs/objects`;

      if (operation === "upload") {
        if (exists) return { oid: obj.oid, size: obj.size };
        // For Blob: check if store provides direct URLs, otherwise proxy
        const directUrl = "getUploadUrl" in lfs ? await lfs.getUploadUrl(obj.oid) : null;
        return {
          oid: obj.oid,
          size: obj.size,
          authenticated: true,
          actions: { upload: { href: directUrl ?? `${baseUrl}/${obj.oid}` } },
        };
      } else {
        if (!exists) {
          return { oid: obj.oid, size: obj.size, error: { code: 404, message: "Not found" } };
        }
        const directUrl = "getDownloadUrl" in lfs ? await lfs.getDownloadUrl(obj.oid) : null;
        return {
          oid: obj.oid,
          size: obj.size,
          authenticated: true,
          actions: { download: { href: directUrl ?? `${baseUrl}/${obj.oid}` } },
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
