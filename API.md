## API Specification – Message Intake Server

Base URL (local): `http://localhost:3000`

### Authentication (required)
- Header: `X-API-KEY: <string>`
- Missing or invalid:
  - HTTP **401**
  - Body: `{ "status": "error", "reason": "Missing API key" }` or `{ "status": "error", "reason": "Invalid API key" }`

---

## Health

### `GET /health`
**Response (200)**

```json
{ "status": "ok" }
```

---

## Messages Intake

### `POST /api/messages`
Receives a message + contacts list, and an optional image, validates them, forwards to the service layer, and returns an immediate response.

#### Processing model (queue)
- Requests are **accepted immediately** and enqueued.
- Processing is **FIFO** and **sequential** (only one job is processed at a time).
- The API response does **not** wait for the job to finish.

#### Request
- Content-Type: `multipart/form-data`
- Headers:
  - `X-API-KEY: <string>` (required)

##### Form fields

1) **`data`** (required, string – JSON)

> Updated rule: the server accepts **either** an image **or** message+contacts (not both).

```json
{
  "contacts": [
    { "name": "David", "phone": "972501234567" },
    { "name": "Moshe", "phone": "972541112233" }
  ]
}
```

Message mode example (no image):

```json
{
  "message": "שלום, זאת הודעה",
  "contacts": [
    { "name": "David", "phone": "972501234567" }
  ]
}
```

Image mode example (no message):

```json
{
  "contacts": [
    { "name": "David", "phone": "972501234567" }
  ]
}
```

2) **`image`** (optional, file)
- Allowed types: `image/jpeg`, `image/png`, `image/webp`
- Size limit: 10MB

#### Validation rules
- `data` must be a valid JSON string.
- `contacts` must be a non-empty array.
- Each contact:
  - `name`: non-empty string
  - `phone`: digits only, length 8–15 (E.164 without `+`)
- Either:
  - **Message mode**: `message` is a non-empty string AND `image` must be absent
  - **Image mode**: `image` must be present AND `message` must be absent/empty

#### Success response
- HTTP **200**

```json
{
  "status": "ok",
  "received": 2,
  "hasImage": true
}
```

#### Error responses

##### Invalid payload
- HTTP **400**

```json
{
  "status": "error",
  "reason": "Invalid payload"
}
```

##### Invalid image type
- HTTP **400**

```json
{
  "status": "error",
  "reason": "Invalid image type"
}
```

##### Image too large
- HTTP **500** (Multer limit error currently handled by the generic error handler)

```json
{
  "status": "error",
  "reason": "Internal error"
}
```

> If you want this to return HTTP 400 with a clearer reason, we can add a specific Multer error mapper.

#### Example (Windows `curl`)

Without image:

```bash
curl -X POST http://localhost:3000/api/messages ^
  -H "X-API-KEY: change-me" ^
  -F "data={\"message\":\"שלום, זאת הודעה\",\"contacts\":[{\"name\":\"David\",\"phone\":\"972501234567\"},{\"name\":\"Moshe\",\"phone\":\"972541112233\"}]}"
```

With image:

```bash
curl -X POST http://localhost:3000/api/messages ^
  -H "X-API-KEY: change-me" ^
  -F "data={\"message\":\"שלום, זאת הודעה\",\"contacts\":[{\"name\":\"David\",\"phone\":\"972501234567\"}]}" ^
  -F "image=@C:\\path\\to\\image.jpg"
```


