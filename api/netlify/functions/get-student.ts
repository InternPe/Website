import { Handler } from "@netlify/functions";
import { MongoClient, Db } from "mongodb";

// ─── Types ────────────────────────────────────────────────────────────────────

interface StudentDocument {
  _id: string;
  fullId: string;
  name: string;
  domain: string;
  startDate: string;
  endDate: string;
  totalWeeks: number;
}

interface StudentResponse {
  id: string;
  name: string;
  domain: string;
  startDate: string;
  endDate: string;
  totalWeeks: number;
}

// ─── DB Connection ────────────────────────────────────────────────────────────

const MONGO_URI = process.env.MONGODB_URI!;
const DB_NAME = process.env.DB_NAME ?? "studentsDB";
const COL_NAME = "students";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "*",
};

let cachedDb: Db | null = null;

async function connectDB(): Promise<Db> {
  if (cachedDb) return cachedDb;
  const client = await MongoClient.connect(MONGO_URI);
  cachedDb = client.db(DB_NAME);
  return cachedDb;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: CORS_HEADERS,
      body: "",
    };
  }

  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  // Extract numeric ID from query param  ─  frontend sends just "72581"
  const rawId = event.queryStringParameters?.id?.trim();

  if (!rawId) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Missing required query parameter: id" }),
    };
  }

  // Strip "IPI#" prefix if the frontend accidentally sends the full ID
  const numericId = rawId.replace(/^IPI#/i, "").trim();

  if (!/^\d+$/.test(numericId)) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: `Invalid ID format: "${rawId}". Expected numeric digits only.`,
      }),
    };
  }

  try {
    const db = await connectDB();
    const col = db.collection<StudentDocument>(COL_NAME);
    const student = await col.findOne({ _id: numericId });

    if (!student) {
      return {
        statusCode: 404,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: `Student with ID IPI#${numericId} not found.`,
        }),
      };
    }

    const response: StudentResponse = {
      id: student.fullId,
      name: student.name,
      domain: student.domain,
      startDate: student.startDate,
      endDate: student.endDate,
      totalWeeks: student.totalWeeks,
    };

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      body: JSON.stringify(response),
    };
  } catch (err: any) {
    console.error("get-student error:", err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: err.message ?? "Internal Server Error" }),
    };
  }
};
