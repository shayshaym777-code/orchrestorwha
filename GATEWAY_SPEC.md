# GATEWAY_SPEC.md (Spec סופי – Gateway API)

אתה המתכנת האחראי על **Gateway API** ואתה “הקובע” של ה־**Spec וההתנהגות בשגיאות**.  
המטרה: ליצור **אפיון סגור** שבאמצעותו בלבד אפשר לשלוח בקשות — כל דבר שלא עומד בו **נחסם**.

> Gateway = “קולט → מאמת → מכניס לתור → מחזיר ACK”.  
> Gateway **לא** נוגע ב־Docker/Orchestrator/Workers.

---

## 1) Public API – Endpoint יחיד (חובה)

### `POST /v1/jobs`

- **Auth**: Header חובה `X-API-KEY: <string>`
- **Idempotency**: נתמך כדי למנוע כפילויות (ראה סעיף 4).
- **מודל עיבוד**:
  - מחזיר ACK **מיד** אחרי enqueue לתור.
  - **לא** מחכה לשליחה/ביצוע.

---

## 2) Payload קשיח (אין חריגים)

### 2.1 כללים ברזל (Strict)
- תמיד מגיע `contacts` בתור **JSON array**.
- תמיד מגיע **או** `message` **או** `image` (**לא** שניהם).
- כל שדה לא מוכר/נוסף → **400** (`Unknown field`).
- `contacts` בפורמט JSON array בלבד (שלב 1). **לא** מחרוזת CSV, לא טקסט, לא אובייקט.

### 2.2 Content-Types נתמכים (Strict)
Gateway מקבל רק אחת משתי צורות בקשה:

#### A) Message mode (JSON)
- `Content-Type: application/json`
- Body:

```json
{
  "idempotencyKey": "string (optional)",
  "message": "string (required, non-empty)",
  "contacts": [
    { "name": "string (required)", "phone": "string (required)" }
  ]
}
```

#### B) Image mode (Multipart)
- `Content-Type: multipart/form-data`
- Fields:
  - `idempotencyKey` (optional, string)
  - `contacts` (required, **JSON array** בתור מחרוזת JSON; חייב להצליח `JSON.parse` ולצאת array)
  - `image` (required, file)
- אסור לשלוח `message` במצב image.

> הערה: “contacts JSON array בלבד” נשמר גם ב־multipart: השדה הוא מחרוזת JSON שמייצגת array בלבד, ולא פורמט אחר.

---

## 3) Validation קשיחה (מה נחסם)

### 3.1 `contacts`
- חייב להיות array עם לפחות פריט אחד.
- כל פריט חייב להיות אובייקט עם:
  - `name`: string לא ריק, עד 80 תווים.
  - `phone`: ספרות בלבד (`0-9`), אורך 8–15 (E.164 ללא `+`).

### 3.2 `message`
- חובה ב־Message mode.
- string לא ריק (trim), עד 4096 תווים.

### 3.3 `image`
- חובה ב־Image mode.
- **Types נתמכים בלבד**: `image/jpeg`, `image/png`, `image/webp`
- **Size limit**: עד **10MB**.

### 3.4 `idempotencyKey`
- אופציונלי.
- אם קיים: string באורך 1–128, תווים מותרים: `[A-Za-z0-9._-]`

---

## 4) Response אחיד + Errors אחידים

### 4.1 Success (תמיד 200)
```json
{ "status": "ok", "jobId": "string", "received": 2, "hasImage": false }
```

- `jobId`: מזהה יציב (לדוגמה UUID/ULID) שנוצר ב־Gateway.
- `received`: מספר אנשי הקשר שנקלטו (`contacts.length`).
- `hasImage`: boolean.

### 4.2 Errors (תמיד אחיד)
תמיד:
```json
{ "status": "error", "reason": "string", "code": "string (optional)" }
```

#### קודי סטטוס (Strict)
- **401**: בעיית Auth (`Missing API key` / `Invalid API key`)
- **400**: Payload/validation (כולל Content-Type שגוי, JSON לא תקין, שדות חסרים/מיותרים)
- **413**: קובץ גדול מדי
- **415**: סוג קובץ לא נתמך
- **429**: Rate limit
- **500**: תקלה פנימית בלבד (Bug/exception פנימית)
- **503**: תלות קריטית לא זמינה (Redis/Queue/Media store)

#### דוגמאות errors (לא מחייב reason טקסט זהה, אבל צריך להיות ברור)
- 401:
```json
{ "status": "error", "reason": "Missing API key", "code": "AUTH_MISSING" }
```
- 400:
```json
{ "status": "error", "reason": "Invalid payload", "code": "PAYLOAD_INVALID" }
```
- 503:
```json
{ "status": "error", "reason": "Queue unavailable", "code": "QUEUE_UNAVAILABLE" }
```

> חשוב: `reason` נועד להיות קריא וברור. `code` נועד להיות יציב למכונה (לוגים/אינטגרציות).

---

## 5) Handling תקלות (הגדרה מחייבת)

### 5.1 Redis / Queue down
- אם Redis לא זמין, או enqueue נכשל:
  - **HTTP 503**
  - Body: `{ status:'error', reason:'Queue unavailable', code:'QUEUE_UNAVAILABLE' }`
  - **לא** מחזירים 200 “כאילו” — אין ACK בלי enqueue מוצלח.

### 5.2 Upload/Media store נכשל
ב־Image mode, אחרי קבלת הקובץ:
- אם שמירה זמנית נכשלה בגלל תלות (Storage down/IO error חיצוני):
  - **HTTP 503**
  - `code: 'MEDIA_UNAVAILABLE'`
- אם נכשלה בגלל חריגה פנימית/באג:
  - **HTTP 500**
  - `code: 'INTERNAL_ERROR'`

### 5.3 Validation נכשלת
- **HTTP 400**
- `code: 'PAYLOAD_INVALID'` (או קוד ספציפי יותר, יציב)

### 5.4 Idempotency (מניעת כפילויות)
- אם מגיע `idempotencyKey` שכבר נצפה בעבר:
  - Gateway **חייב** להחזיר את אותו `jobId` שכבר נוצר עבור המפתח הזה.
  - Response הוא **200** עם אותו payload הצלחה.
- אם מגיע `idempotencyKey` חדש:
  - יוצרים `jobId` חדש, שומרים mapping `idempotencyKey -> jobId` עם TTL (מומלץ 24 שעות), ואז enqueue.

> “Spec סגור”: אם `idempotencyKey` לא עומד בחוקיות (אורך/תווים) → 400.

---

## 6) Flow מחייב (“מה קורה מרגע שהבקשה מגיעה”)

1. **Validate auth** (`X-API-KEY`)
2. **Parse + validate** (Content-Type, payload, contacts, mode)
3. אם יש `image`:
   - שמירה זמנית עם TTL
   - יצירת `mediaRef` (מזהה פנימי לשימוש worker בהמשך)
4. **Idempotency**:
   - אם `idempotencyKey` מוכר → מחזירים ACK עם אותו `jobId` (ולא יוצרים עבודה כפולה)
   - אחרת ממשיכים
5. **Enqueue** ל־Redis (BullMQ) עם `jobId` ו־payload תקין (כולל `mediaRef` אם קיים)
6. **Return ACK מיד** (200) — לא מחכים לשליחה

---

## 7) Rate Limit (אם מופעל)

- במקרה של חריגה:
  - **HTTP 429**
  - `{ status:'error', reason:'Rate limit exceeded', code:'RATE_LIMIT' }`

> מותר להוסיף headers סטנדרטיים (`Retry-After`) אך לא חובה.

---

## 8) דוגמאות `curl`

### 8.1 Message mode (JSON)

PowerShell:
```powershell
curl -X POST http://localhost:3000/v1/jobs `
  -H "X-API-KEY: change-me" `
  -H "Content-Type: application/json" `
  -d "{\"idempotencyKey\":\"demo-001\",\"message\":\"שלום\",\"contacts\":[{\"name\":\"David\",\"phone\":\"972501234567\"}]}"
```

### 8.2 Image mode (multipart)

PowerShell:
```powershell
curl -X POST http://localhost:3000/v1/jobs `
  -H "X-API-KEY: change-me" `
  -F "idempotencyKey=demo-img-001" `
  -F "contacts=[{`"name`":`"David`",`"phone`":`"972501234567`"}]" `
  -F "image=@C:\path\to\image.jpg"
```

---

## 9) Acceptance Tests (חובה לספק)

### 9.1 20 בדיקות קלטים שגויים (חייבים להיחסם נכון)
להלן רשימת מינימום (אפשר יותר), כל אחת עם סטטוס+body אחידים:

1. ללא `X-API-KEY` → 401 (`AUTH_MISSING`)
2. `X-API-KEY` שגוי → 401 (`AUTH_INVALID`)
3. `POST /v1/jobs` עם `Content-Type` חסר → 400 (`CONTENT_TYPE_INVALID`)
4. `Content-Type: text/plain` → 400 (`CONTENT_TYPE_INVALID`)
5. JSON לא תקין ב־Message mode → 400 (`JSON_INVALID`)
6. אין `contacts` → 400 (`PAYLOAD_INVALID`)
7. `contacts` לא array (למשל אובייקט) → 400
8. `contacts` array ריק → 400
9. איש קשר בלי `name` → 400
10. `name` ריק/רק רווחים → 400
11. איש קשר בלי `phone` → 400
12. `phone` כולל `+`/תווים לא ספרתיים → 400
13. `phone` קצר מדי/ארוך מדי → 400
14. Message mode בלי `message` → 400
15. `message` ריק → 400
16. נשלחים גם `message` וגם `image` → 400
17. Image mode בלי `image` → 400
18. `image` מסוג לא נתמך (למשל GIF) → 415 (`UNSUPPORTED_MEDIA_TYPE`)
19. `image` גדול מ־10MB → 413 (`FILE_TOO_LARGE`)
20. שדה לא מוכר (למשל `foo: 1`) → 400 (`UNKNOWN_FIELD`)

### 9.2 בדיקת עומס בסיסית
- שליחת **100 בקשות** ל־`POST /v1/jobs` (Message mode) ברצף/במקביל.
- ציפייה:
  - כל הבקשות חוזרות **200** מהר (ACK), בלי timeouts, בלי “תקיעה”.

### 9.3 בדיקה שכש־Redis נופל → 503 עקבי
- מכבים Redis / מנתקים קישור.
- כל `POST /v1/jobs` חייב להחזיר:
  - **503**
  - `{ status:'error', reason:'Queue unavailable', code:'QUEUE_UNAVAILABLE' }`

### 9.4 בדיקת Idempotency
- שולחים פעמיים אותה בקשה עם אותו `idempotencyKey`.
- ציפייה:
  - שתי התשובות: **200**
  - אותו `jobId` בדיוק בשתיהן
  - לא נוצרים שני jobs שונים בתור עבור אותו מפתח


