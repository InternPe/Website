# Netlify Serverless Functions — Student Data API

Two TypeScript Netlify functions to upload student Excel data to MongoDB and retrieve it by ID.

---

## Project Structure

```
netlify/functions/
  upload-students.ts   ← POST /api/upload-students
  get-student.ts       ← GET  /api/student?id=72581
netlify.toml           ← URL rewrites
package.json
tsconfig.json
.env.example
```

---

## Setup

```bash
npm install
cp .env.example .env   # fill in MONGODB_URI
```

---

## API Reference

### 1. POST `/api/upload-students`

Upload an Excel file. All rows are upserted into MongoDB.

**Request** — `multipart/form-data`

| Field  | Type | Description              |
|--------|------|--------------------------|
| `file` | File | `.xlsx` file with student data |

**Excel columns expected:**

| Column       | Example          |
|--------------|------------------|
| `ID`         | `IPI#72581`      |
| `Name`       | `John Doe`       |
| `Domain`     | `Web Development`|
| `Start Date` | `2024-01-15`     |
| `End Date`   | `2024-06-30`     |

**Success Response `200`**
```json
{
  "message": "Upload successful.",
  "inserted": 5,
  "modified": 2,
  "total": 7
}
```

---

### 2. GET `/api/student?id=72581`

Fetch a student's details. Frontend sends **only the numeric part** — `IPI#` is added automatically by the function.

**Query Param**

| Param | Example | Notes                         |
|-------|---------|-------------------------------|
| `id`  | `72581` | Numeric part of the student ID |

**Success Response `200`**
```json
{
  "id": "IPI#72581",
  "name": "John Doe",
  "domain": "Web Development",
  "startDate": "2024-01-15",
  "endDate": "2024-06-30"
}
```

**Error Responses**

| Code | Reason                        |
|------|-------------------------------|
| `400`| Missing or invalid `id` param |
| `404`| Student not found             |
| `500`| MongoDB / server error        |

---

## Frontend Usage Example

```typescript
// Upload Excel
const formData = new FormData();
formData.append("file", excelFile);

await fetch("/api/upload-students", {
  method: "POST",
  body: formData,
});

// Get student — user types "72581", IPI# is NOT needed on the frontend
const res  = await fetch(`/api/student?id=${studentInput}`);
const data = await res.json();
// data.id → "IPI#72581"
```

---

## Environment Variables

Set these in **Netlify Dashboard → Site Settings → Environment Variables**:

| Variable      | Description                      |
|---------------|----------------------------------|
| `MONGODB_URI` | MongoDB Atlas connection string  |
| `DB_NAME`     | Database name (default: `studentsDB`) |

---

## Local Development

```bash
npm run dev   # starts netlify dev server on http://localhost:8888
```
