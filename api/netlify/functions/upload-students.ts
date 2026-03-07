import { Handler, HandlerEvent } from "@netlify/functions";
import { MongoClient, Db } from "mongodb";
import * as XLSX from "xlsx";

// ─── Types ────────────────────────────────────────────────────────────────────

interface StudentRow {
  ID: string;
  Name: string;
  Domain: string;
  "Start Date": string | number;
  "End Date": string | number;
  "Total Weeks": string | number;
}

interface StudentDocument {
  _id: string; // numeric part only, e.g. "72581"
  fullId: string; // e.g. "IPI#72581"
  name: string;
  domain: string;
  startDate: string; // ISO date string
  endDate: string;
  totalWeeks: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
const UPLOAD_TOKEN = process.env.UPLOAD_API_TOKEN!;
const MONGO_URI = process.env.MONGODB_URI!;
const DB_NAME = process.env.DB_NAME ?? "studentsDB";
const COL_NAME = "students";

let cachedDb: Db | null = null;

async function connectDB(): Promise<Db> {
  if (cachedDb) return cachedDb;
  const client = await MongoClient.connect(MONGO_URI);
  cachedDb = client.db(DB_NAME);
  return cachedDb;
}

/** Parse Excel serial number OR regular date string → ISO date string */
function parseDate(value: string | number): string {
  if (typeof value === "number") {
    // Excel serial date → JS Date
    const date = XLSX.SSF.parse_date_code(value);
    return new Date(date.y, date.m - 1, date.d).toISOString().split("T")[0];
  }
  return new Date(value).toISOString().split("T")[0];
}

/** Extract numeric ID from "IPI#72581" → "72581" */
function extractNumericId(fullId: string): string {
  return fullId.replace(/^IPI#/i, "").trim();
}

/** Parse multipart/form-data body and return the file buffer */
function extractFileBuffer(event: HandlerEvent): Buffer {
  if (!event.isBase64Encoded || !event.body) {
    throw new Error("Request body is missing or not base64-encoded.");
  }

  const bodyBuffer = Buffer.from(event.body, "base64");
  const contentType = event.headers["content-type"] ?? "";
  const boundaryMatch = contentType.match(/boundary=(.+)/);

  if (!boundaryMatch) throw new Error("No multipart boundary found.");

  const boundary = `--${boundaryMatch[1]}`;
  const bodyStr = bodyBuffer.toString("binary");
  const parts = bodyStr.split(boundary);

  for (const part of parts) {
    if (part.includes("filename=") && part.includes("Content-Type")) {
      // Split headers from file content
      const headerBodySplit = part.indexOf("\r\n\r\n");
      if (headerBodySplit === -1) continue;
      const fileContent = part.slice(
        headerBodySplit + 4,
        part.lastIndexOf("\r\n"),
      );
      return Buffer.from(fileContent, "binary");
    }
  }

  throw new Error("No file found in the multipart body.");
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  // ── Auth check ───────────────────────────────────────────────────────────
  const authHeader = event.headers["authorization"] ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token || token !== UPLOAD_TOKEN) {
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  try {
    // 1. Extract file buffer from multipart body
    const fileBuffer = extractFileBuffer(event);

    // 2. Parse Excel
    const workbook = XLSX.read(fileBuffer, {
      type: "buffer",
      cellDates: false,
    });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<StudentRow>(sheet);

    if (!rows.length) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Excel file is empty." }),
      };
    }

    // 3. Map rows → documents
    const documents: StudentDocument[] = rows.map((row) => {
      const fullId = String(row["ID"]).trim();
      const numericId = extractNumericId(fullId);

      return {
        _id: numericId,
        fullId,
        name: String(row["Name"]).trim(),
        domain: String(row["Domain"]).trim(),
        startDate: parseDate(row["Start Date"]),
        endDate: parseDate(row["End Date"]),
        totalWeeks: Number(row["Total Weeks"]) || 0,
      };
    });

    // 4. Upsert into MongoDB (replace if ID already exists)
    const db = await connectDB();
    const col = db.collection<StudentDocument>(COL_NAME);

    const bulkOps = documents.map((doc) => ({
      replaceOne: {
        filter: { _id: doc._id },
        replacement: doc,
        upsert: true,
      },
    }));

    const result = await col.bulkWrite(bulkOps as any);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Upload successful.",
        inserted: result.upsertedCount,
        modified: result.modifiedCount,
        total: documents.length,
      }),
    };
  } catch (err: any) {
    console.error("upload-students error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message ?? "Internal Server Error" }),
    };
  }
};
