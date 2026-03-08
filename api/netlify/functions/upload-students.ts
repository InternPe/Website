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
  Duration: string | number;
}

interface StudentDocument {
  _id: string; // numeric part only, e.g. "72581"
  fullId: string; // e.g. "IPI#72581"
  name: string;
  domain: string;
  startDate: string; // ISO date string
  endDate: string;
  duration: string;
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

function toISODate(date: Date): string | null {
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().split("T")[0];
}

/** Parse Excel serial/date string into ISO; throws detailed row/field errors */
function parseDate(
  value: string | number | undefined,
  field: "Start Date" | "End Date",
  rowNumber: number,
): string {
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error(`Row ${rowNumber}: Missing ${field}.`);
  }

  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) {
      throw new Error(
        `Row ${rowNumber}: Invalid ${field} serial value "${value}".`,
      );
    }
    const iso = toISODate(new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d)));
    if (!iso) {
      throw new Error(
        `Row ${rowNumber}: Invalid ${field} serial value "${value}".`,
      );
    }
    return iso;
  }

  const raw = String(value).trim();
  const dmy = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    const year = Number(dmy[3]);
    const iso = toISODate(new Date(Date.UTC(year, month - 1, day)));
    if (!iso) {
      throw new Error(`Row ${rowNumber}: Invalid ${field} value "${raw}".`);
    }
    return iso;
  }

  const iso = toISODate(new Date(raw));
  if (!iso) {
    throw new Error(`Row ${rowNumber}: Invalid ${field} value "${raw}".`);
  }
  return iso;
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

    // 3. Validate/map rows → documents
    const documents: StudentDocument[] = [];
    const rowErrors: string[] = [];

    rows.forEach((row, idx) => {
      const rowNumber = idx + 2; // +2 to account for 1-indexed sheet row + header row
      try {
        const fullId = String(row["ID"] ?? "").trim();
        if (!fullId) throw new Error(`Row ${rowNumber}: Missing ID.`);

        const numericId = extractNumericId(fullId);
        if (!/^\d+$/.test(numericId)) {
          throw new Error(`Row ${rowNumber}: Invalid ID "${fullId}".`);
        }

        const name = String(row["Name"] ?? "").trim();
        const domain = String(row["Domain"] ?? "").trim();
        if (!name) throw new Error(`Row ${rowNumber}: Missing Name.`);
        if (!domain) throw new Error(`Row ${rowNumber}: Missing Domain.`);

        documents.push({
          _id: numericId,
          fullId,
          name,
          domain,
          startDate: parseDate(row["Start Date"], "Start Date", rowNumber),
          endDate: parseDate(row["End Date"], "End Date", rowNumber),
          duration: String(row["Duration"] ?? "").trim(),
        });
      } catch (error: any) {
        rowErrors.push(error?.message ?? `Row ${rowNumber}: Invalid data.`);
      }
    });

    if (rowErrors.length) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Invalid rows in uploaded file.",
          issues: rowErrors.slice(0, 10),
          totalIssues: rowErrors.length,
        }),
      };
    }

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
